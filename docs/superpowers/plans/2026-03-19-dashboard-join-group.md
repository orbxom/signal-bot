# Dashboard Join Group via Invite Link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to join Signal groups from the dashboard by pasting an invite link.

**Architecture:** Three-layer change — add `joinGroup(uri)` to the signal client, add `POST /api/groups/join` to the dashboard API, add an input+button to the Groups page. TDD throughout.

**Tech Stack:** TypeScript, Express, React, Vitest, Supertest

**Spec:** `docs/superpowers/specs/2026-03-19-dashboard-join-group-design.md`

---

### Task 1: Signal Client — `joinGroup(uri)` method

**Files:**
- Modify: `bot/src/signalClient.ts:78-80` (add after `quitGroup`)
- Test: `bot/tests/signalClient.test.ts:643` (add after `quitGroup` tests)

- [ ] **Step 1: Write the failing test**

Add a new `describe('joinGroup')` block in `bot/tests/signalClient.test.ts` after the `quitGroup` describe block (line 663):

```typescript
describe('joinGroup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls joinGroup RPC method with uri and account params', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: '1', result: {} }),
    });
    const client = new SignalClient('http://localhost:8080', '+61400000000');
    await expect(client.joinGroup('https://signal.group/#abc123')).resolves.not.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.method).toBe('joinGroup');
    expect(body.params.uri).toBe('https://signal.group/#abc123');
    expect(body.params.account).toBe('+61400000000');
  });

  it('throws on RPC error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: '1', error: { message: 'Invalid group link' } }),
    });
    const client = new SignalClient('http://localhost:8080', '+61400000000');
    await expect(client.joinGroup('https://signal.group/#bad')).rejects.toThrow('Invalid group link');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/signalClient.test.ts -t "joinGroup"`
Expected: FAIL — `client.joinGroup is not a function`

- [ ] **Step 3: Write minimal implementation**

Add after the `quitGroup` method in `bot/src/signalClient.ts` (after line 80):

```typescript
async joinGroup(uri: string): Promise<void> {
  await this.rpc<void>('joinGroup', { uri });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/signalClient.test.ts -t "joinGroup"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add bot/src/signalClient.ts bot/tests/signalClient.test.ts
git commit -m "feat: add joinGroup(uri) to SignalClient"
```

---

### Task 2: Dashboard API — `POST /api/groups/join`

**Files:**
- Modify: `dashboard/src/routes/groups.ts:49-66` (add before `return router`)
- Test: `dashboard/tests/routes/groups.test.ts`

- [ ] **Step 1: Add `joinGroup` to the mock in the test file**

In `dashboard/tests/routes/groups.test.ts`, add `joinGroup: vi.fn()` to the `mockSignalClient` object (after `quitGroup` on line 28):

```typescript
mockSignalClient = {
  listGroups: vi.fn(),
  getGroup: vi.fn(),
  quitGroup: vi.fn(),
  joinGroup: vi.fn(),
};
```

- [ ] **Step 2: Write failing tests for the join endpoint**

Add at the end of the `describe('groups routes')` block in `dashboard/tests/routes/groups.test.ts`:

```typescript
describe('POST /api/groups/join', () => {
  it('joins group and returns refreshed group list', async () => {
    mockSignalClient.joinGroup.mockResolvedValue(undefined);
    mockSignalClient.listGroups.mockResolvedValue([
      { id: 'g1', name: 'Family', members: ['+1'] },
      { id: 'g2', name: 'New Group', members: ['+1', '+2'] },
    ]);
    mockStorage.groupSettings.get.mockReturnValue(null);
    mockStorage.personas.getActiveForGroup.mockReturnValue(null);

    const res = await request(app)
      .post('/api/groups/join')
      .send({ uri: 'https://signal.group/#abc123' });

    expect(res.status).toBe(200);
    expect(mockSignalClient.joinGroup).toHaveBeenCalledWith('https://signal.group/#abc123');
    expect(res.body.groups).toHaveLength(2);
  });

  it('returns 202 when group not found after join (admin approval pending)', async () => {
    mockSignalClient.joinGroup.mockResolvedValue(undefined);
    // listGroups called twice: before join (1 group) and after join (still 1 group — new group not yet visible)
    mockSignalClient.listGroups
      .mockResolvedValueOnce([{ id: 'g1', name: 'Family', members: ['+1'] }])
      .mockResolvedValueOnce([{ id: 'g1', name: 'Family', members: ['+1'] }]);
    mockStorage.groupSettings.get.mockReturnValue(null);
    mockStorage.personas.getActiveForGroup.mockReturnValue(null);

    const res = await request(app)
      .post('/api/groups/join')
      .send({ uri: 'https://signal.group/#needs-approval' });

    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/awaiting admin approval/);
  });

  it('returns 400 for missing uri', async () => {
    const res = await request(app)
      .post('/api/groups/join')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Signal group invite link/);
  });

  it('returns 400 for malformed uri', async () => {
    const res = await request(app)
      .post('/api/groups/join')
      .send({ uri: 'https://example.com/not-a-signal-link' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Signal group invite link/);
  });

  it('returns 422 when signal-cli rejects the link', async () => {
    mockSignalClient.joinGroup.mockRejectedValue(new Error('Signal RPC error: Invalid group link'));

    const res = await request(app)
      .post('/api/groups/join')
      .send({ uri: 'https://signal.group/#expired' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Invalid group link/);
  });

  it('returns 500 on unexpected errors', async () => {
    mockSignalClient.joinGroup.mockRejectedValue(new TypeError('Cannot read properties of undefined'));

    const res = await request(app)
      .post('/api/groups/join')
      .send({ uri: 'https://signal.group/#abc123' });

    expect(res.status).toBe(500);
  });

  it('returns 503 when signal-cli is unreachable', async () => {
    mockSignalClient.joinGroup.mockRejectedValue(new Error('Signal API error: ECONNREFUSED'));

    const res = await request(app)
      .post('/api/groups/join')
      .send({ uri: 'https://signal.group/#abc123' });

    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run tests/routes/groups.test.ts -t "POST /api/groups/join"`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 4: Implement the route**

Add before `return router;` in `dashboard/src/routes/groups.ts`:

```typescript
router.post('/groups/join', async (req, res) => {
  const { uri } = req.body;
  if (!uri || typeof uri !== 'string' || !uri.startsWith('https://signal.group/#')) {
    return res.status(400).json({ error: 'Invalid Signal group invite link format' });
  }
  try {
    // Snapshot group IDs before joining
    const beforeGroups = (await signalClient.listGroups()) as Array<{ id: string }>;
    const beforeIds = new Set(beforeGroups.map((g) => g.id));

    await signalClient.joinGroup(uri);

    // Refresh group list after joining
    const signalGroups = (await signalClient.listGroups()) as Array<{
      id: string;
      name: string;
      members: string[];
    }>;

    // Check if a new group appeared (admin-approval groups won't show up yet)
    const newGroupFound = signalGroups.some((g) => !beforeIds.has(g.id));
    if (!newGroupFound) {
      return res.status(202).json({ message: 'Join request sent — awaiting admin approval' });
    }

    const enriched = signalGroups.map((g) => {
      const settings = storage.groupSettings.get(g.id);
      return {
        ...g,
        enabled: settings ? settings.enabled : true,
        activePersona: storage.personas.getActiveForGroup(g.id)?.name ?? 'Default',
        settings,
      };
    });
    res.json({ groups: enriched });
  } catch (err) {
    const message = (err as Error).message || 'Unknown error';
    if (message.includes('Signal RPC error')) {
      return res.status(422).json({ error: message });
    }
    if (message.includes('Signal API error')) {
      return res.status(503).json({ error: 'Signal service unavailable' });
    }
    res.status(500).json({ error: 'Failed to join group' });
  }
});
```

**Design decisions:**
- Snapshots the group list before joining and compares after, to detect the admin-approval case (joinGroup succeeds but no new group appears → 202).
- Returns `{ groups: [...] }` on success so the UI can replace its list state directly without a separate refetch.
- Error routing: `Signal RPC error` → 422 (signal-cli rejected the request), `Signal API error` → 503 (connection/HTTP failure), anything else → 500 (unexpected).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run tests/routes/groups.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/groups.ts dashboard/tests/routes/groups.test.ts
git commit -m "feat: add POST /api/groups/join endpoint"
```

---

### Task 3: Dashboard UI — Join Group input on Groups page

**Files:**
- Modify: `dashboard/client/src/pages/Groups.tsx`

- [ ] **Step 1: Add join group form state and handler**

Replace the contents of `dashboard/client/src/pages/Groups.tsx` with:

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Group {
  id: string
  name: string
  members: string[]
  enabled: boolean
  activePersona: string
}

const columns = [
  {
    key: 'enabled',
    header: 'Status',
    render: (row: Group) => (
      <span style={{ color: row.enabled ? '#8f8' : '#e74' }}>
        {row.enabled ? 'Active' : 'Disabled'}
      </span>
    ),
  },
  { key: 'name', header: 'Name' },
  {
    key: 'members',
    header: 'Members',
    render: (row: Group) => row.members?.length ?? 0,
  },
  { key: 'activePersona', header: 'Persona' },
]

export default function Groups() {
  const { data: groups, loading, setData: setGroups, refetch } = useApi<Group[]>('/api/groups')
  const navigate = useNavigate()
  const [uri, setUri] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joinSuccess, setJoinSuccess] = useState<string | null>(null)

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    if (!uri.trim() || joining) return
    setJoining(true)
    setJoinError(null)
    setJoinSuccess(null)
    try {
      const result = await apiCall('POST', '/api/groups/join', { uri: uri.trim() }) as
        | { groups: Group[] }
        | { message: string }
      if ('groups' in result) {
        setGroups(result.groups)
      } else {
        // 202 admin approval — show message, refetch to update list
        setJoinSuccess(result.message)
      }
      setUri('')
    } catch (err) {
      setJoinError((err as Error).message)
    } finally {
      setJoining(false)
    }
  }

  return (
    <div>
      <h1>Groups</h1>
      <form onSubmit={handleJoin} style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          type="text"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="Paste Signal group invite link..."
          disabled={joining}
          style={{ flex: 1, padding: '8px' }}
        />
        <button type="submit" disabled={joining || !uri.trim()}>
          {joining ? 'Joining...' : 'Join'}
        </button>
      </form>
      {joinError && (
        <div style={{ color: '#e74c3c', marginBottom: '12px' }}>{joinError}</div>
      )}
      {joinSuccess && (
        <div style={{ color: '#f39c12', marginBottom: '12px' }}>{joinSuccess}</div>
      )}
      <DataTable<Group>
        columns={columns}
        data={groups ?? []}
        loading={loading}
        onRowClick={(row) => navigate(`/groups/${row.id}`)}
        emptyMessage="No groups found"
      />
    </div>
  )
}
```

**Note:** This uses `setData` from the `useApi` hook to directly update the group list from the POST response, avoiding a redundant refetch. If `useApi` doesn't currently expose `setData`, add it — see Step 2.

- [ ] **Step 2: Expose `setData` from `useApi` hook (if needed)**

Check if `useApi` already exposes `setData`. If not, add it to `dashboard/client/src/hooks/useApi.ts`:

```typescript
// In the return statement, add setData:
return { data, loading, error, refetch, setData }
```

- [ ] **Step 3: Manual verification**

1. Start the dashboard: `cd dashboard && npm run dev`
2. Open http://localhost:3333/groups
3. Verify the input field and "Join" button appear above the group list
4. Try submitting an empty input — button should be disabled
5. Try submitting a non-Signal URL — should show error message
6. (If signal-cli is running) Try a real invite link — group should appear in the list

- [ ] **Step 4: Commit**

```bash
git add dashboard/client/src/pages/Groups.tsx dashboard/client/src/hooks/useApi.ts
git commit -m "feat: add join-group input to dashboard Groups page"
```

---

### Task 4: Full integration test

- [ ] **Step 1: Run all bot tests**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run all dashboard tests**

Run: `cd dashboard && npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Run linter**

Run: `cd bot && npm run check && cd ../dashboard && npm run check 2>/dev/null || true`
Expected: No lint errors in bot or dashboard

- [ ] **Step 4: Build dashboard client**

Run: `cd dashboard/client && npm run build`
Expected: Build succeeds with no TypeScript errors
