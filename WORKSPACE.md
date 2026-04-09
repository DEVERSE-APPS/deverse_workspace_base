# BUN Monorepo Workspace Architecture

## Overview

DEVERSE uses a **single-container BUN monorepo architecture** where all artifacts run in one Podman container with a central router that proxies requests to individual artifact dev servers.

```
User Browser
    ↓
{project_id}.localhost:8081 (Traefik)
    ↓
Container w1_{project_id}:3000
    ↓
router.ts (reads deverse.json)
    ↓
Routes by path → proxies to artifact ports
    /artifacts/main-app/* → :5173 (Vite)
    /artifacts/auth-api/* → :3001 (Express)
    /data/* → uploaded CSV/JSON
    /assets/* → brand assets
    /health → {status: "ok"}
```

---

## Complete User Creation Flow

### Step 1: User Creates Project (REST API)

```
POST /api/projects/
{
  "name": "My App",
  "description": "Build a dashboard for analytics",
  "project_type": "full_stack_app",
  "stack_type": "bun_monorepo"
}
```

**What happens:**
- Project record created in database
- `status = "pending"`
- `frontend_port` allocated atomically (via PortAllocation model)
- Response sent immediately (202 Accepted)

### Step 2: Workspace Creation Starts (Background Thread)

**Called from:** `apps/projects/views.py:ProjectViewSet.create()`

```python
workspace_service = WorkspaceService()
thread = threading.Thread(
    target=workspace_service.create_bun_workspace,
    kwargs={
        'project_id': project.id,
        'skip_agent': False,  # Important: agent WILL be dispatched
    },
    daemon=True
)
thread.start()
```

**Timeline (orchestrator.py:create_bun_workspace):**

```
Time 0:   status = "cloning_repos" (10%)
          └─ Git clone: https://github.com/DEVERSE-APPS/deverse_workspace_base
          └─ Remove .git directory (keep workspace clean)

Time 30s: status = "initializing" (20%)
          └─ Create deverse.json: {"version": 1, "artifacts": []}

Time 40s: status = "creating_containers" (30%)
          └─ podman create --volume /workspace_path:/workspace
          └─ command=['sh', '-c', 'cd /workspace && bun router.ts']
          └─ Container: w1_{project_id}
          └─ Network: traefik-net (if USE_TRAEFIK=true)

Time 50s: status = "starting_services" (50%)
          └─ podman start w1_{project_id}
          └─ router.ts listening on :3000

Time 60s: status = "starting_services" (65%)
          └─ Health check: curl http://container:3000/health
          └─ Wait max 60 seconds
          └─ Returns {"status": "ok"} ✅

Time 70s: status = "starting_services" (80%)
          └─ If Traefik enabled:
             └─ Create traefik/dynamic/project-{short_id}.yml
             └─ Routes {short_id}.localhost:8081 → container:3000

Time 75s: status = "ready" (100%)
```

**Important:** Container now running with:
- **deverse.json**: `{"version": 1, "artifacts": []}`  (empty!)
- **router.ts**: Listening on :3000, ready to proxy
- **No artifacts yet** ← This is key!

### Step 3: Agent Dispatched (Still in Background Thread)

```python
# From orchestrator.py line ~926
if not skip_agent:
    agent_manager.schedule_agent_from_thread(
        project_id=str(project.id),
        message="",                    # Empty message!
        user_id=str(project.user.id),
        mode="initial",                # Initial mode
    )
```

**What happens next:**

The agent manager **IMMEDIATELY** sends the initial message to the **ORCHESTRATOR AGENT**:

```python
# From agent_manager.py line ~625-629
content = (
    f"USER REQUIREMENTS (Initial Project Description):\n"
    f"{project.description}\n\n"
    f"This is the initial project setup. Please analyze "
    f"the requirements and begin planning."
)

# Dispatch to orchestrator
agent.invoke(
    {"messages": [HumanMessage(content=content)]},
    config=config
)
```

---

## Agent Workflow: When Artifacts Are Created

### Phase 1: ORCHESTRATOR Receives Initial Message

```
Message: "Build a dashboard for analytics"
         "This is the initial project setup. Please analyze and begin planning."

Agent reads:
  - Project description
  - stack_type = "bun_monorepo" ✅
  - Project type = "full_stack_app"
  - Container = "w1_{project_id}" running ✅
  
Decision: "This is a full_stack_app, I need to call the PLANNER"
```

### Phase 2: PLANNER Agent Starts

The Orchestrator **delegates** to the Planner by using sub-agent invoke:

```python
# From planner agent
# Input: User requirements, project type, project context

# Planner reads:
1. project.description ("Build a dashboard for analytics")
2. project_type ("full_stack_app")
3. Container context from ProjectContext (workspace_path, container name)

# Planner's job:
# - Understand requirements
# - Create API_SPEC.md (defines endpoints)
# - Create architecture plan
# - Create deverse_artifacts/tasks.md

# Planner creates task list like:
# B1-01: Create API (HTTP endpoints, database schema)
# B2-01: Create Web App (React/Vite pages, components)
# B3-01: Create Slides (optional)

# IMPORTANT: Planner does NOT call scaffold_artifact yet!
```

### Phase 3: API Builder (Backend Phase)

```python
# api_builder agent receives plan from Planner

# api_builder does:
1. Read API_SPEC.md generated by planner
2. Call: scaffold_artifact("api", "main-api")
   
   This CLONES artifact-api template from GitHub and:
   ✅ Clones: https://github.com/DEVERSE-APPS/artifact-api
   ✅ Into: /workspace/artifacts/main-api/
   ✅ Replaces:
       %%NAME%% → "main-api"
       %%PORT%% → 3001 (allocated dynamically)
       %%BASE_PATH%% → "/artifacts/main-api/"
   ✅ Runs: podman exec w1_{project_id} bun install (inside container!)
   ✅ Starts dev server: podman exec -d bun run dev
   ✅ Updates deverse.json:
       {
         "artifacts": [
           {
             "id": "main-api",
             "type": "api",
             "path": "/artifacts/main-api/",
             "localPort": 3001,
             "startCmd": "bun run dev",
             "entryDir": "artifacts/main-api"
           }
         ]
       }

3. router.ts now reads updated deverse.json
   → Routes /artifacts/main-api/* → localhost:3001 ✅

4. api_builder then:
   - Edits files in /workspace/artifacts/main-api/src/
   - Creates API endpoints matching API_SPEC.md
   - Updates package.json, tsconfig, vite config
```

### Phase 4: Web Builder (Frontend Phase)

```python
# web_builder agent receives plan

# web_builder does:
1. Call: scaffold_artifact("webapp", "main-app")
   
   This CLONES artifact-web template:
   ✅ Clones: https://github.com/DEVERSE-APPS/artifact-web
   ✅ Into: /workspace/artifacts/main-app/
   ✅ Replaces placeholders
   ✅ Port 5173 allocated
   ✅ Updates deverse.json

2. router.ts now routes:
   /artifacts/main-app/* → localhost:5173 ✅

3. web_builder then:
   - Edits files in /workspace/artifacts/main-app/src/
   - Creates React components, pages
   - Can import from @deverse/api-client (generated from API_SPEC)
```

---

## Artifact Template Structure

When an artifact is scaffolded, it's cloned from GitHub. Each template has:

```
artifact-api/
├── lib/
│   ├── api-spec/
│   │   ├── openapi.yaml          ← API spec template
│   │   ├── orval.config.ts        ← Code generation config
│   │   └── package.json
│   ├── api-client/
│   │   ├── src/
│   │   │   ├── custom-fetch.ts   ← Custom fetch with auth
│   │   │   ├── index.ts
│   │   │   └── generated/        ← Generated by Orval
│   │   └── package.json
│   ├── api-zod/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── generated/        ← Generated Zod schemas
│   │   └── package.json
│   └── shared-lib/
│       ├── src/
│       │   ├── types.ts          ← ApiResponse, ApiError
│       │   ├── utils.ts          ← formatDate, getErrorMessage
│       │   ├── constants.ts      ← API_VERSION, ERROR_CODES
│       │   └── index.ts
│       └── package.json
├── src/
│   ├── lib/
│   │   └── db.ts                 ← PostgreSQL pool + Drizzle
│   ├── routes/
│   ├── main.ts
│   └── ...
├── deverse.artifact.json          ← Metadata (name, type, port)
├── package.json                   ← Workspaces + scripts
└── tsconfig.json
```

---

## Key Timeline Summary

```
T+0:   User creates project
T+5s:  create_bun_workspace() called in background
T+30s: deverse_workspace_base cloned, deverse.json created
T+50s: Container created, router.ts starting
T+60s: Health check passes, status = "ready"
T+65s: Traefik route registered (if enabled)
T+70s: Agent dispatched to Orchestrator
T+71s: Orchestrator reads description, calls Planner
T+80s: Planner generates specs and tasks
T+90s: API Builder scaffolds artifact-api → /artifacts/main-api/
       ✅ deverse.json updated
       ✅ router.ts proxies /artifacts/main-api/* → :3001
T+100s: Web Builder scaffolds artifact-web → /artifacts/main-app/
        ✅ deverse.json updated
        ✅ router.ts proxies /artifacts/main-app/* → :5173
T+110s: Builders edit artifact files
T+180s: All artifacts complete, user can preview
```

---

## URL Access

### Local Development (Port-based routing)

```
Browser → localhost:3100 (frontend_port)
  ↓
Podman → container:3000
  ↓
router.ts reads deverse.json
  ↓
/artifacts/main-app/* → :5173 (Vite dev server)
/artifacts/main-api/* → :3001 (Express dev server)
/health → {status: "ok"}
```

### With Traefik (Subdomain routing)

```
Browser → {short_id}.localhost:8081 (Traefik)
  ↓
Traefik routes to container:3000 based on Host(`{short_id}.localhost`)
  ↓
Same routing as above
```

### Production (Would be deployed separately)

```
Browser → https://{project_id}.deverse.app
  ↓
router.ts --prod mode (serves built artifacts from dist/)
```

---

## Important Implementation Details

### 1. deverse.json is Live

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "main-api",
      "type": "api",
      "path": "/artifacts/main-api/",
      "localPort": 3001,
      "startCmd": "bun run dev",
      "entryDir": "artifacts/main-api"
    },
    {
      "id": "main-app",
      "type": "webapp",
      "path": "/artifacts/main-app/",
      "localPort": 5173,
      "startCmd": "bun run dev",
      "entryDir": "artifacts/main-app"
    }
  ]
}
```

**router.ts watches deverse.json** for changes. When scaffold_artifact() updates it, router.ts automatically:
1. Reloads the manifest
2. Recognizes new artifacts
3. Routes requests to correct ports

### 2. Artifact Dev Servers

Each artifact is a standalone npm project:

```bash
# Inside container for main-api artifact
cd /workspace/artifacts/main-api
bun install              # Uses pre-warmed cache (fast)
bun run dev              # Starts on port 3001
```

### 3. BUN Workspaces

Each artifact has internal dependencies:

```json
{
  "workspaces": ["lib/*"],
  "dependencies": {
    "@deverse/api-client": "workspace:*",
    "@deverse/shared-lib": "workspace:*"
  }
}
```

When artifact is scaffolded:
- `bun install` installs all workspace packages
- Artifacts can import: `import { formatDate } from '@deverse/shared-lib'`

### 4. When Artifacts Become "Ready"

An artifact is ready when:
1. ✅ Template cloned from GitHub
2. ✅ Placeholders replaced
3. ✅ `bun install` complete
4. ✅ Dev server started (`bun run dev`)
5. ✅ Registered in deverse.json
6. ✅ router.ts routing active

**User can then:**
- View at `/artifacts/{name}/` in browser
- See hot-reload via Vite HMR (WebSocket)
- Agents can edit files and see live changes

---

## Single Container Benefits

| Aspect | Benefit |
|--------|---------|
| **Simplicity** | One container, one network, one router |
| **Resource Efficient** | All artifacts share same container memory/CPU |
| **Dynamic** | Agents can scaffold artifacts on-demand |
| **HMR Friendly** | WebSocket upgrade routing via router.ts |
| **Development Speed** | No container orchestration overhead |
| **Debugging** | Single `podman exec` into container for logs |

---

## File Paths Reference

```
HOST: /home/nova/Dev/Temp/project-{uuid}/
  └─ /workspace                      (mounted to container)
      ├─ deverse.json                ← Live artifact manifest
      ├─ router.ts                   ← Main router process
      ├─ artifacts/
      │   ├─ main-api/               ← API artifact (cloned from artifact-api template)
      │   │   ├─ src/
      │   │   │   └─ routes/
      │   │   ├─ lib/
      │   │   │   ├─ api-spec/
      │   │   │   ├─ api-client/
      │   │   │   ├─ api-zod/
      │   │   │   └─ db/
      │   │   └─ package.json
      │   └─ main-app/               ← Web artifact (cloned from artifact-web template)
      │       ├─ src/
      │       │   ├─ pages/
      │       │   └─ components/
      │       ├─ lib/
      │       │   ├─ api-client/
      │       │   └─ shared-lib/
      │       └─ package.json
      ├─ lib/                        ← Shared workspace libs (if any)
      ├─ data/                       ← User uploaded CSVs/JSON
      ├─ assets/                     ← Brand assets (logos, fonts)
      └─ deverse_artifacts/          ← Agent-generated specs
          ├─ API_SPEC.md
          ├─ tasks.md
          └─ ...

CONTAINER: /workspace (same structure)
```

---

## Debugging Checklist

**Container not running?**
```bash
podman ps | grep w1_
podman logs w1_{project_id}
```

**Health check failing?**
```bash
podman exec w1_{project_id} curl http://localhost:3000/health
```

**Artifact not accessible?**
```bash
cat /workspace/deverse.json  # Check if artifact registered
podman exec w1_{project_id} ps aux | grep "bun run dev"  # Check dev servers
```

**Traefik not routing?**
```bash
cat /home/nova/DEVERSE/traefik/dynamic/project-{short_id}.yml
curl -H "Host: {short_id}.localhost" http://localhost:8081/health
```

---

## See Also

- [workspace_tools.py](../../apps/agents/tools/workspace_tools.py) — `scaffold_artifact()` implementation
- [orchestrator.py](../../services/workspace/orchestrator.py) — `create_bun_workspace()` implementation
- [router.ts](./router.ts) — Main router proxying logic
- [artifact-api template](https://github.com/DEVERSE-APPS/artifact-api)
- [artifact-web template](https://github.com/DEVERSE-APPS/artifact-web)
