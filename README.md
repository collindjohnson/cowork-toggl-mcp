# Toggl MCP Server

An MCP (Model Context Protocol) server for the [Toggl Track API v9](https://engineering.toggl.com/docs/track/). Enables AI assistants to manage time entries, projects, clients, and workspaces in Toggl.

## Tools

| Tool | Description |
|------|-------------|
| `toggl_get_current_user` | Get the authenticated user's profile |
| `toggl_list_workspaces` | List all workspaces |
| `toggl_list_time_entries` | List time entries with optional date filtering |
| `toggl_get_current_time_entry` | Get the currently running timer |
| `toggl_get_time_entry` | Get a specific time entry by ID |
| `toggl_create_time_entry` | Create or start a new time entry |
| `toggl_stop_time_entry` | Stop a running timer |
| `toggl_update_time_entry` | Update an existing time entry |
| `toggl_delete_time_entry` | Delete a time entry |
| `toggl_list_projects` | List projects in a workspace |
| `toggl_create_project` | Create a new project |
| `toggl_list_clients` | List clients in a workspace |

## Setup

### 1. Get Your API Token

Log in to Toggl → go to [https://track.toggl.com/profile](https://track.toggl.com/profile) → scroll to "API Token".

### 2. Set Environment Variable

```bash
export TOGGL_API_KEY=your_api_token_here
```

Or create a `.env` file (see `.env.example`).

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Run

```bash
# HTTP mode (for Vercel / remote)
TRANSPORT=http npm start

# stdio mode (for local Claude Desktop)
TRANSPORT=stdio npm start
```

## Deploying to Vercel

1. Push this repo to GitHub
2. Import the project on [vercel.com](https://vercel.com)
3. Add the environment variable `TOGGL_API_KEY` in Vercel's project settings
4. Deploy — your MCP endpoint will be at `https://your-app.vercel.app/mcp`

## Connecting to Claude

Add the MCP server URL to your Claude configuration:

```
https://your-app.vercel.app/mcp
```

## Authentication

Uses Toggl's Basic Auth with your API token as the username and `api_token` as the password — handled automatically by the server. **Never hardcode your API key** — always use the `TOGGL_API_KEY` environment variable.
