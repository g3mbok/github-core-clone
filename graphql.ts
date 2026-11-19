import { createComment, createIssue, createPull, globalId, mergePull, pullChangedFiles } from './domain.ts';

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const SEARCH_TYPES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function tokenize(source) {
  const tokens = [];
  const pattern = /\s+|#[^\r\n]*|"(?:\\.|[^"\\])*"|\.\.\.|[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|[$!():{},\[\]=@]/gy;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Unexpected GraphQL token near ${source.slice(index, index + 20)}`);
    index = pattern.lastIndex;
    if (/^\s+$/.test(match[0]) || match[0].startsWith('#')) continue;
    tokens.push(match[0]);
  }
  return tokens;
}

function parseDocument(source, variables) {
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const expect = (token) => {
    if (take() !== token) throw new Error(`Expected ${token}`);
  };
  const skipGroup = (open, close) => {
    if (peek() !== open) return;
    let depth = 0;
    do {
      const current = take();
      if (current === open) depth += 1;
      else if (current === close) depth -= 1;
    } while (index < tokens.length && depth > 0);
  };
  const parseValue = () => {
    const token = take();
    if (token === '$') return variables[take()];
    if (token === '[') {
      const values = [];
      while (peek() !== ']') {
        values.push(parseValue());
        if (peek() === ',') take();
      }
      expect(']');
      return values;
    }
    if (token === '{') {
      const value = {};
      while (peek() !== '}') {
        const key = take();
        expect(':');
        value[key] = parseValue();
        if (peek() === ',') take();
      }
      expect('}');
      return value;
    }
    if (token?.startsWith('"')) return JSON.parse(token);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token !== undefined && /^-?\d/.test(token)) return Number(token);
    return token;
  };
  const parseSelection = () => {
    expect('{');
    const selection = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        take();
        const on = take();
        if (on !== 'on') throw new Error('Unsupported fragment spread');
        const type = take();
        selection.push({ fragment: type, children: parseSelection() });
        continue;
      }
      let first = take();
      if (!first) throw new Error('Unexpected end of selection');
      let alias = null;
      if (peek() === ':') {
        take();
        alias = first;
        first = take();
      }
      const args = {};
      if (peek() === '(') {
        take();
        while (peek() !== ')') {
          const key = take();
          expect(':');
          args[key] = parseValue();
          if (peek() === ',') take();
        }
        expect(')');
      }
      while (peek() === '@') {
        take();
        take();
        skipGroup('(', ')');
      }
      const children = peek() === '{' ? parseSelection() : [];
      selection.push({ name: first, alias, args, children });
    }
    expect('}');
    return selection;
  };
  let operation = 'query';
  if (peek() !== '{') {
    operation = take();
    if (peek() !== '(' && peek() !== '{') take();
    skipGroup('(', ')');
  }
  while (peek() === '@') {
    take();
    take();
    skipGroup('(', ')');
  }
  const selection = parseSelection();
  return { operation, selection };
}

function repoById(store, id) {
  const raw = String(id ?? '');
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  const number = Number((decoded.startsWith('Repository:') ? decoded : raw).split(':').pop());
  return [...store.repos.values()].find((repo) => repo.id === number) ?? null;
}

function objectByGlobalId(store, id, type) {
  const decoded = Buffer.from(String(id), 'base64').toString('utf8');
  if (!decoded.startsWith(`${type}:`)) return null;
  const number = Number(decoded.slice(type.length + 1));
  if (type === 'Repository') return [...store.repos.values()].find((repo) => repo.id === number) ?? null;
  for (const repo of store.repos.values()) {
    const collection = type === 'Issue' ? repo.issues : repo.pulls;
    for (const item of collection.values()) if (item.id === number) return { repo, item };
  }
  return null;
}

function issueGraph(issue) {
  return {
    __typename: 'Issue',
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    labels: issue.labels,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function pullGraph(pull) {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    merged: pull.merged,
    mergedAt: pull.merged_at,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pull.mergeable === false ? 'CONFLICTING' : 'MERGEABLE',
    pull,
  };
}

function resolve(root, field, args, store, viewer) {
  const type = root?.__typename;
  if (type === 'Query') {
    if (field === 'viewer') return { __typename: 'User', login: viewer };
    if (field === 'repository') return store.getRepo(args.owner, args.name) ? { __typename: 'Repository', repo: store.getRepo(args.owner, args.name) } : null;
    if (field === '__type') {
      const name = args.name;
      if (name === 'SearchType') return { __typename: 'EnumType', enumValues: SEARCH_TYPES.map((value) => ({ name: value })) };
      return TYPE_FIELDS[name] ? { __typename: 'ObjectType', fields: TYPE_FIELDS[name].map((value) => ({ name: value })) } : null;
    }
    if (field === 'node') {
      const decoded = Buffer.from(String(args.id ?? ''), 'base64').toString('utf8');
      const repo = repoById(store, decoded);
      return repo ? { __typename: 'Repository', repo } : null;
    }
    return undefined;
  }
  if (type === 'Mutation') {
    if (field === 'createIssue') {
      const repo = repoById(store, args.input?.repositoryId);
      if (!repo) return null;
      return { __typename: 'CreateIssuePayload', issue: issueGraph(createIssue(store, repo, args.input)) };
    }
    if (field === 'closeIssue') {
      const found = objectByGlobalId(store, args.input?.issueId, 'Issue');
      if (!found) return null;
      found.item.state = 'closed';
      found.item.updated_at = '2025-01-01T00:00:00Z';
      return { __typename: 'CloseIssuePayload', issue: issueGraph(found.item) };
    }
    if (field === 'createPullRequest') {
      const repo = repoById(store, args.input?.repositoryId);
      if (!repo) return null;
      const pull = createPull(store, repo, { head: args.input.headRefName, base: args.input.baseRefName, title: args.input.title, body: args.input.body });
      if (!pull.head.sha || !pull.base.sha) { repo.pulls.delete(pull.number); return null; }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullGraph(pull) };
    }
    if (field === 'mergePullRequest') {
      const found = objectByGlobalId(store, args.input?.pullRequestId, 'PullRequest');
      if (!found) return null;
      const result = mergePull(found.repo, found.item);
      if (result.status !== 200) return null;
      return { __typename: 'MergePullRequestPayload', pullRequest: pullGraph(found.item) };
    }
    if (field === 'addComment') {
      const found = objectByGlobalId(store, args.input?.subjectId, 'Issue');
      if (!found) return null;
      const comment = createComment(store, found.item, args.input.body);
      return { __typename: 'AddCommentPayload', commentEdge: { node: { __typename: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body } } };
    }
    return undefined;
  }
  if (type === 'User') return field === 'login' ? root.login : undefined;
  if (type === 'Repository') {
    const repo = root.repo;
    if (field === 'id') return globalId('Repository', repo.id);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'owner') return { __typename: 'User', login: repo.owner };
    if (field === 'defaultBranchRef') {
      const exists = repo.refs.has(`refs/heads/${repo.defaultBranch}`);
      return exists ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueGraph(issue) : null;
    }
    if (field === 'issues') {
      let items = [...repo.issues.values()];
      if (Array.isArray(args.states) && args.states.length) {
        const states = args.states.map((state) => String(state).toLowerCase());
        items = items.filter((issue) => states.includes(issue.state));
      }
      items.sort((a, b) => b.number - a.number);
      const after = args.after == null ? null : Number(String(args.after).split(':').pop());
      if (Number.isFinite(after)) items = items.filter((issue) => issue.number < after);
      const start = 0;
      const first = Math.max(0, Number(args.first ?? items.length));
      const page = items.slice(start, start + first);
      return {
        __typename: 'IssueConnection',
        nodes: page.map(issueGraph),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: items.length > page.length,
          endCursor: page.length ? `issue:${page[page.length - 1].number}` : null,
        },
      };
    }
    if (field === 'pullRequests') {
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, Math.max(0, Number(args.first ?? 20)));
      return { __typename: 'PullRequestConnection', nodes: pulls.map(pullGraph) };
    }
    if (field === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullGraph(pull) : null;
    }
    return undefined;
  }
  if (type === 'Issue') {
    if (field === 'id' || field === 'number' || field === 'title' || field === 'state' || field === 'body' || field === 'labels' || field === 'createdAt' || field === 'updatedAt') return root[field];
  }
  if (type === 'PullRequest') {
    if (field === 'id' || field === 'number' || field === 'title' || field === 'body' || field === 'state' || field === 'merged' || field === 'mergedAt' || field === 'headRefName' || field === 'baseRefName' || field === 'mergeable') return root[field];
    if (field === 'files') {
      const files = pullChangedFiles(root.pull.base.repo, root.pull);
      const first = Math.max(0, Number(args.first ?? files.length));
      return { __typename: 'PullRequestChangedFileConnection', nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })) };
    }
  }
  if (type === 'ObjectType') {
    if (field === 'fields') return root.fields;
  }
  if (type === 'EnumType' && field === 'enumValues') return root.enumValues;
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection') {
    if (field === 'nodes') return root.nodes;
  }
  if (type === 'PageInfo') {
    if (field === 'hasNextPage' || field === 'endCursor') return root[field];
  }
  if (type === 'Ref' && field === 'name') return root.name;
  if (type === 'CreateIssuePayload' && field === 'issue') return root.issue;
  if (type === 'CloseIssuePayload' && field === 'issue') return root.issue;
  if (type === 'CreatePullRequestPayload' && field === 'pullRequest') return root.pullRequest;
  if (type === 'MergePullRequestPayload' && field === 'pullRequest') return root.pullRequest;
  if (type === 'AddCommentPayload' && field === 'commentEdge') return root.commentEdge;
  if (type === 'IssueComment' && (field === 'id' || field === 'body')) return root[field];
  if (root && Object.prototype.hasOwnProperty.call(root, field)) return root[field];
  return undefined;
}

function project(value, selections, store, viewer, errors) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, selections, store, viewer, errors));
  if (typeof value !== 'object') return value;
  const output = {};
  for (const selection of selections) {
    if (selection.fragment) {
      if (selection.fragment === value.__typename || (selection.fragment === 'Node' && value.__typename === 'Repository')) {
        Object.assign(output, project(value, selection.children, store, viewer, errors));
      }
      continue;
    }
    const raw = resolve(value, selection.name, selection.args, store, viewer);
    if (raw === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${value.__typename ?? 'Query'}".` });
      output[selection.alias ?? selection.name] = null;
    } else {
      output[selection.alias ?? selection.name] = selection.children.length ? project(raw, selection.children, store, viewer, errors) : raw;
    }
  }
  return output;
}

function execute(store, viewer, body) {
  const parsed = parseDocument(String(body.query ?? ''), body.variables ?? {});
  const root = { __typename: parsed.operation === 'mutation' ? 'Mutation' : 'Query' };
  const errors = [];
  const data = project(root, parsed.selection, store, viewer, errors);
  return errors.length ? { data, errors } : { data };
}

export async function handleGraphql(req, res, store, token, viewer) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/graphql' && url.pathname !== '/graphql') return false;
  const authorization = req.headers.authorization ?? '';
  if (!token || authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] }));
    return true;
  }
  const evaluate = (document) => {
    try { return execute(store, viewer, document); }
    catch (failure) { return { data: null, errors: [{ message: failure instanceof Error ? failure.message : 'GraphQL execution failed' }] }; }
  };
  const response = Array.isArray(body) ? body.map(evaluate) : evaluate(body);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(response));
  return true;
}
