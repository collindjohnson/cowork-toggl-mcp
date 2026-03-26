#!/usr/bin/env node
/**
 * Toggl Track MCP Server
 *
 * Provides tools to interact with the Toggl Track API v9, including
 * time entry management, project management, and workspace operations.
 *
 * Authentication: Set TOGGL_API_KEY environment variable to your Toggl API token.
 * Find your token at: https://track.toggl.com/profile
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";

import { CHARACTER_LIMIT, ResponseFormat } from "./constants.js";
import type {
  TogglClient,
  TogglProject,
  TogglTimeEntry,
  TogglUser,
  TogglWorkspace,
} from "./types.js";
import {
  formatDate,
  formatDuration,
  handleApiError,
  togglDelete,
  togglGet,
  togglPatch,
  togglPost,
  togglPut,
} from "./services/toggl.js";

// ─── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "toggl-mcp-server",
  version: "1.0.0",
});

// ─── Shared Schemas ────────────────────────────────────────────────────────────

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50)
    .describe("Maximum number of results to return (1–200, default 50)"),
  offset: z.number().int().min(0).default(0)
    .describe("Number of results to skip for pagination (default 0)"),
});

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n[Response truncated — use offset/limit parameters to page through results]"
  );
}

// ─── Tool: Get Current User ────────────────────────────────────────────────────

server.registerTool(
  "toggl_get_current_user",
  {
    title: "Get Current Toggl User",
    description: `Retrieve the profile of the currently authenticated Toggl user.

Returns name, email, timezone, default workspace, and account metadata.

Returns:
  For JSON: Full user object from /me endpoint.
  For Markdown: Human-readable profile summary.

Examples:
  - "Who am I logged in as?" → toggl_get_current_user()
  - "What is my default workspace ID?" → toggl_get_current_user()`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ response_format }) => {
    try {
      const user = await togglGet<TogglUser>("/me");

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(user, null, 2) }] };
      }

      const text = [
        `# Toggl User Profile`,
        `**Name**: ${user.fullname}`,
        `**Email**: ${user.email}`,
        `**Timezone**: ${user.timezone}`,
        `**Default Workspace ID**: ${user.default_workspace_id}`,
        `**Account Created**: ${formatDate(user.created_at)}`,
        `**Last Updated**: ${formatDate(user.updated_at)}`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: List Workspaces ─────────────────────────────────────────────────────

server.registerTool(
  "toggl_list_workspaces",
  {
    title: "List Toggl Workspaces",
    description: `List all workspaces the authenticated user belongs to.

Returns workspace IDs, names, plan details, and admin status.

Returns:
  For JSON: Array of workspace objects.
  For Markdown: Table of workspaces.

Examples:
  - "What workspaces do I have?" → toggl_list_workspaces()
  - "Get my workspace ID" → toggl_list_workspaces()`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ response_format }) => {
    try {
      const workspaces = await togglGet<TogglWorkspace[]>("/me/workspaces");

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(workspaces, null, 2) }] };
      }

      const lines = [`# Toggl Workspaces (${workspaces.length})`, ""];
      for (const ws of workspaces) {
        lines.push(`## ${ws.name} (ID: ${ws.id})`);
        lines.push(`- **Admin**: ${ws.admin ? "Yes" : "No"}`);
        lines.push(`- **Premium**: ${ws.premium ? "Yes" : "No"}`);
        lines.push(`- **Currency**: ${ws.default_currency}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: List Time Entries ───────────────────────────────────────────────────

server.registerTool(
  "toggl_list_time_entries",
  {
    title: "List Toggl Time Entries",
    description: `List recent time entries for the authenticated user, with optional date range filtering.

Returns time entry IDs, descriptions, projects, durations, and timestamps.

Args:
  - start_date (string, optional): Filter entries starting from this date (ISO 8601, e.g. "2024-01-01")
  - end_date (string, optional): Filter entries up to this date (ISO 8601, e.g. "2024-01-31")
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For JSON: Array of time entry objects.
  For Markdown: Formatted list grouped by date.

Examples:
  - "Show my time entries this week" → toggl_list_time_entries(start_date="2024-01-08")
  - "What did I track in January?" → toggl_list_time_entries(start_date="2024-01-01", end_date="2024-01-31")
  - "Show all recent time entries" → toggl_list_time_entries()

Error Handling:
  - Returns auth error if TOGGL_API_KEY is invalid`,
    inputSchema: z.object({
      start_date: z.string().optional()
        .describe("Filter from this date (ISO 8601 format, e.g. '2024-01-01')"),
      end_date: z.string().optional()
        .describe("Filter to this date (ISO 8601 format, e.g. '2024-01-31')"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ start_date, end_date, response_format }) => {
    try {
      const params: Record<string, unknown> = {};
      if (start_date) params.start_date = start_date;
      if (end_date) params.end_date = end_date;

      const entries = await togglGet<TogglTimeEntry[]>("/me/time_entries", params);

      if (!entries.length) {
        return { content: [{ type: "text", text: "No time entries found for the specified date range." }] };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: truncate(JSON.stringify(entries, null, 2)) }] };
      }

      const lines = [`# Time Entries (${entries.length} found)`, ""];
      for (const entry of entries) {
        const duration = formatDuration(entry.duration);
        const start = formatDate(entry.start);
        const desc = entry.description || "_No description_";
        lines.push(`### ${desc}`);
        lines.push(`- **ID**: ${entry.id}`);
        lines.push(`- **Start**: ${start}`);
        if (entry.stop) lines.push(`- **Stop**: ${formatDate(entry.stop)}`);
        lines.push(`- **Duration**: ${duration}`);
        if (entry.project_id) lines.push(`- **Project ID**: ${entry.project_id}`);
        if (entry.tags?.length) lines.push(`- **Tags**: ${entry.tags.join(", ")}`);
        lines.push(`- **Billable**: ${entry.billable ? "Yes" : "No"}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Get Current Running Entry ──────────────────────────────────────────

server.registerTool(
  "toggl_get_current_time_entry",
  {
    title: "Get Current Running Time Entry",
    description: `Get the currently running (active) time entry, if any.

Returns null/empty if no timer is currently running.

Returns:
  For JSON: The active time entry object or null.
  For Markdown: Summary of the active timer.

Examples:
  - "Is my timer running?" → toggl_get_current_time_entry()
  - "What am I tracking right now?" → toggl_get_current_time_entry()`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ response_format }) => {
    try {
      const entry = await togglGet<TogglTimeEntry | null>("/me/time_entries/current");

      if (!entry) {
        return { content: [{ type: "text", text: "No timer is currently running." }] };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      }

      const elapsed = Math.floor((Date.now() - new Date(entry.start).getTime()) / 1000);
      const text = [
        `# ⏱ Active Timer`,
        `**Description**: ${entry.description || "_No description_"}`,
        `**Running for**: ${formatDuration(elapsed)}`,
        `**Started**: ${formatDate(entry.start)}`,
        `**ID**: ${entry.id}`,
        `**Workspace**: ${entry.workspace_id}`,
        entry.project_id ? `**Project ID**: ${entry.project_id}` : null,
        entry.tags?.length ? `**Tags**: ${entry.tags.join(", ")}` : null,
        `**Billable**: ${entry.billable ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Get Time Entry ──────────────────────────────────────────────────────

server.registerTool(
  "toggl_get_time_entry",
  {
    title: "Get Toggl Time Entry",
    description: `Get a specific time entry by its ID.

Args:
  - time_entry_id (number): The ID of the time entry to retrieve
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For JSON: Full time entry object.
  For Markdown: Formatted time entry details.

Examples:
  - "Show details for time entry 123456" → toggl_get_time_entry(time_entry_id=123456)`,
    inputSchema: z.object({
      time_entry_id: z.number().int().positive().describe("The time entry ID"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ time_entry_id, response_format }) => {
    try {
      const entry = await togglGet<TogglTimeEntry>(`/me/time_entries/${time_entry_id}`);

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      }

      const text = [
        `# Time Entry: ${entry.description || "_No description_"}`,
        `**ID**: ${entry.id}`,
        `**Start**: ${formatDate(entry.start)}`,
        `**Stop**: ${entry.stop ? formatDate(entry.stop) : "_Still running_"}`,
        `**Duration**: ${formatDuration(entry.duration)}`,
        `**Workspace**: ${entry.workspace_id}`,
        entry.project_id ? `**Project ID**: ${entry.project_id}` : null,
        entry.tags?.length ? `**Tags**: ${entry.tags.join(", ")}` : null,
        `**Billable**: ${entry.billable ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Create Time Entry ───────────────────────────────────────────────────

server.registerTool(
  "toggl_create_time_entry",
  {
    title: "Create Toggl Time Entry",
    description: `Create a new time entry in a Toggl workspace.

To start a timer NOW, set duration to -1 and omit stop.
To log a completed entry, provide start, stop, and duration in seconds.

Args:
  - workspace_id (number): The workspace ID (use toggl_list_workspaces to find it)
  - description (string, optional): Description of the work done
  - start (string): Start time in ISO 8601 format (e.g. "2024-01-15T09:00:00Z")
  - stop (string, optional): Stop time in ISO 8601 format — omit to start a live timer
  - duration (number): Duration in seconds, or -1 to start a running timer
  - project_id (number, optional): Project ID to associate
  - tags (string[], optional): List of tag names
  - billable (boolean, optional): Whether the entry is billable (default false)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  The created time entry with its assigned ID.

Examples:
  - "Start a timer for client call" → toggl_create_time_entry(workspace_id=123, description="Client call", start="2024-01-15T10:00:00Z", duration=-1)
  - "Log 2 hours of design work" → toggl_create_time_entry(workspace_id=123, description="Design work", start="2024-01-15T09:00:00Z", stop="2024-01-15T11:00:00Z", duration=7200)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      description: z.string().optional().describe("What you worked on"),
      start: z.string().describe("Start time in ISO 8601 format (e.g. '2024-01-15T09:00:00Z')"),
      stop: z.string().optional().describe("Stop time in ISO 8601 format — omit for a running timer"),
      duration: z.number().int().describe("Duration in seconds, or -1 for a running timer"),
      project_id: z.number().int().positive().optional().describe("Project ID to associate"),
      tags: z.array(z.string()).optional().describe("Tag names to apply"),
      billable: z.boolean().optional().default(false).describe("Whether this entry is billable"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ workspace_id, description, start, stop, duration, project_id, tags, billable, response_format }) => {
    try {
      const body: Record<string, unknown> = {
        workspace_id,
        start,
        duration,
        billable: billable ?? false,
        created_with: "toggl-mcp-server",
      };
      if (description) body.description = description;
      if (stop) body.stop = stop;
      if (project_id) body.project_id = project_id;
      if (tags?.length) body.tags = tags;

      const entry = await togglPost<TogglTimeEntry>(
        `/workspaces/${workspace_id}/time_entries`,
        body
      );

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      }

      const isRunning = entry.duration === -1 || !entry.stop;
      const text = [
        `# ✅ Time Entry ${isRunning ? "Started" : "Created"}`,
        `**ID**: ${entry.id}`,
        `**Description**: ${entry.description || "_No description_"}`,
        `**Start**: ${formatDate(entry.start)}`,
        isRunning ? `**Status**: ⏱ Running` : `**Stop**: ${formatDate(entry.stop)}`,
        !isRunning ? `**Duration**: ${formatDuration(entry.duration)}` : null,
        `**Billable**: ${entry.billable ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Stop Time Entry ─────────────────────────────────────────────────────

server.registerTool(
  "toggl_stop_time_entry",
  {
    title: "Stop Toggl Time Entry",
    description: `Stop a currently running time entry.

Args:
  - workspace_id (number): The workspace ID
  - time_entry_id (number): The ID of the running time entry to stop
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  The stopped time entry with its final duration.

Examples:
  - "Stop my timer" → first call toggl_get_current_time_entry() to get workspace_id and id, then toggl_stop_time_entry(workspace_id=..., time_entry_id=...)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      time_entry_id: z.number().int().positive().describe("The running time entry ID to stop"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workspace_id, time_entry_id, response_format }) => {
    try {
      const entry = await togglPatch<TogglTimeEntry>(
        `/workspaces/${workspace_id}/time_entries/${time_entry_id}/stop`
      );

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      }

      const text = [
        `# ⏹ Timer Stopped`,
        `**Description**: ${entry.description || "_No description_"}`,
        `**Duration**: ${formatDuration(entry.duration)}`,
        `**Started**: ${formatDate(entry.start)}`,
        `**Stopped**: ${formatDate(entry.stop)}`,
        `**ID**: ${entry.id}`,
      ].join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Update Time Entry ───────────────────────────────────────────────────

server.registerTool(
  "toggl_update_time_entry",
  {
    title: "Update Toggl Time Entry",
    description: `Update an existing time entry's description, project, tags, duration, or billable status.

Args:
  - workspace_id (number): The workspace ID
  - time_entry_id (number): The ID of the time entry to update
  - description (string, optional): New description
  - project_id (number | null, optional): New project ID (null to remove)
  - tags (string[], optional): New tag list (replaces existing tags)
  - billable (boolean, optional): Update billable status
  - start (string, optional): New start time in ISO 8601 format
  - stop (string, optional): New stop time in ISO 8601 format
  - duration (number, optional): New duration in seconds
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  The updated time entry.

Examples:
  - "Change the description of entry 123 to 'Client meeting'" → toggl_update_time_entry(workspace_id=..., time_entry_id=123, description="Client meeting")
  - "Mark entry 456 as billable" → toggl_update_time_entry(workspace_id=..., time_entry_id=456, billable=true)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      time_entry_id: z.number().int().positive().describe("Time entry ID to update"),
      description: z.string().optional().describe("New description"),
      project_id: z.number().int().positive().nullable().optional().describe("New project ID (null to remove)"),
      tags: z.array(z.string()).optional().describe("New tag list"),
      billable: z.boolean().optional().describe("New billable status"),
      start: z.string().optional().describe("New start time (ISO 8601)"),
      stop: z.string().optional().describe("New stop time (ISO 8601)"),
      duration: z.number().int().optional().describe("New duration in seconds"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workspace_id, time_entry_id, description, project_id, tags, billable, start, stop, duration, response_format }) => {
    try {
      const body: Record<string, unknown> = { workspace_id };
      if (description !== undefined) body.description = description;
      if (project_id !== undefined) body.project_id = project_id;
      if (tags !== undefined) body.tags = tags;
      if (billable !== undefined) body.billable = billable;
      if (start !== undefined) body.start = start;
      if (stop !== undefined) body.stop = stop;
      if (duration !== undefined) body.duration = duration;

      const entry = await togglPut<TogglTimeEntry>(
        `/workspaces/${workspace_id}/time_entries/${time_entry_id}`,
        body
      );

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      }

      const text = [
        `# ✏️ Time Entry Updated`,
        `**ID**: ${entry.id}`,
        `**Description**: ${entry.description || "_No description_"}`,
        `**Start**: ${formatDate(entry.start)}`,
        `**Stop**: ${entry.stop ? formatDate(entry.stop) : "_Running_"}`,
        `**Duration**: ${formatDuration(entry.duration)}`,
        `**Billable**: ${entry.billable ? "Yes" : "No"}`,
      ].join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Delete Time Entry ───────────────────────────────────────────────────

server.registerTool(
  "toggl_delete_time_entry",
  {
    title: "Delete Toggl Time Entry",
    description: `Permanently delete a time entry. This action cannot be undone.

Args:
  - workspace_id (number): The workspace ID
  - time_entry_id (number): The ID of the time entry to delete
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Confirmation message.

Examples:
  - "Delete time entry 123456" → toggl_delete_time_entry(workspace_id=..., time_entry_id=123456)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      time_entry_id: z.number().int().positive().describe("Time entry ID to delete"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ workspace_id, time_entry_id, response_format }) => {
    try {
      await togglDelete(`/workspaces/${workspace_id}/time_entries/${time_entry_id}`);

      const message = response_format === ResponseFormat.JSON
        ? JSON.stringify({ success: true, deleted_id: time_entry_id })
        : `# 🗑️ Time Entry Deleted\n**ID**: ${time_entry_id} has been permanently deleted.`;

      return { content: [{ type: "text", text: message }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: List Projects ───────────────────────────────────────────────────────

server.registerTool(
  "toggl_list_projects",
  {
    title: "List Toggl Projects",
    description: `List all projects in a workspace, with optional filters.

Args:
  - workspace_id (number): The workspace ID
  - active (boolean, optional): Filter by active status (true = active only, false = archived only)
  - limit (number): Max results to return (1–200, default 50)
  - offset (number): Pagination offset (default 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For JSON: Array of project objects.
  For Markdown: Formatted project list.

Examples:
  - "Show all active projects" → toggl_list_projects(workspace_id=123, active=true)
  - "List my projects" → toggl_list_projects(workspace_id=123)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      active: z.boolean().optional().describe("Filter by active status"),
      ...PaginationSchema.shape,
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workspace_id, active, limit, offset, response_format }) => {
    try {
      const params: Record<string, unknown> = { per_page: limit, page: Math.floor(offset / limit) + 1 };
      if (active !== undefined) params.active = active;

      const projects = await togglGet<TogglProject[]>(
        `/workspaces/${workspace_id}/projects`,
        params
      );

      if (!projects.length) {
        return { content: [{ type: "text", text: "No projects found in this workspace." }] };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: truncate(JSON.stringify(projects, null, 2)) }] };
      }

      const lines = [`# Projects in Workspace ${workspace_id} (${projects.length} found)`, ""];
      for (const p of projects) {
        lines.push(`## ${p.name} (ID: ${p.id})`);
        lines.push(`- **Status**: ${p.active ? "Active" : "Archived"}`);
        lines.push(`- **Billable**: ${p.billable ? "Yes" : "No"}`);
        lines.push(`- **Color**: ${p.color}`);
        if (p.client_id) lines.push(`- **Client ID**: ${p.client_id}`);
        if (p.actual_hours) lines.push(`- **Hours Logged**: ${p.actual_hours}h`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: Create Project ──────────────────────────────────────────────────────

server.registerTool(
  "toggl_create_project",
  {
    title: "Create Toggl Project",
    description: `Create a new project in a workspace.

Args:
  - workspace_id (number): The workspace ID
  - name (string): Project name
  - client_id (number, optional): Client ID to associate with the project
  - color (string, optional): Hex color code (e.g. "#06aaf5")
  - billable (boolean, optional): Whether the project is billable (default false)
  - is_private (boolean, optional): Whether the project is private (default true)
  - active (boolean, optional): Whether the project is active (default true)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  The created project with its assigned ID.

Examples:
  - "Create a project called Website Redesign" → toggl_create_project(workspace_id=123, name="Website Redesign")
  - "Create a billable project for client 456" → toggl_create_project(workspace_id=123, name="Q1 Retainer", client_id=456, billable=true)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      name: z.string().min(1).max(255).describe("Project name"),
      client_id: z.number().int().positive().optional().describe("Client ID to associate"),
      color: z.string().optional().describe("Hex color code (e.g. '#06aaf5')"),
      billable: z.boolean().optional().default(false).describe("Whether the project is billable"),
      is_private: z.boolean().optional().default(true).describe("Whether the project is private"),
      active: z.boolean().optional().default(true).describe("Whether the project is active"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ workspace_id, name, client_id, color, billable, is_private, active, response_format }) => {
    try {
      const body: Record<string, unknown> = {
        name,
        billable: billable ?? false,
        is_private: is_private ?? true,
        active: active ?? true,
      };
      if (client_id) body.client_id = client_id;
      if (color) body.color = color;

      const project = await togglPost<TogglProject>(
        `/workspaces/${workspace_id}/projects`,
        body
      );

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      }

      const text = [
        `# ✅ Project Created`,
        `**Name**: ${project.name}`,
        `**ID**: ${project.id}`,
        `**Workspace**: ${project.workspace_id}`,
        `**Billable**: ${project.billable ? "Yes" : "No"}`,
        `**Status**: ${project.active ? "Active" : "Archived"}`,
        project.client_id ? `**Client ID**: ${project.client_id}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Tool: List Clients ────────────────────────────────────────────────────────

server.registerTool(
  "toggl_list_clients",
  {
    title: "List Toggl Clients",
    description: `List all clients in a workspace.

Args:
  - workspace_id (number): The workspace ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For JSON: Array of client objects.
  For Markdown: Formatted client list.

Examples:
  - "Show all clients" → toggl_list_clients(workspace_id=123)
  - "List my clients in workspace 456" → toggl_list_clients(workspace_id=456)`,
    inputSchema: z.object({
      workspace_id: z.number().int().positive().describe("Workspace ID"),
      response_format: ResponseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workspace_id, response_format }) => {
    try {
      const clients = await togglGet<TogglClient[]>(`/workspaces/${workspace_id}/clients`);

      if (!clients.length) {
        return { content: [{ type: "text", text: "No clients found in this workspace." }] };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(clients, null, 2) }] };
      }

      const lines = [`# Clients in Workspace ${workspace_id} (${clients.length} found)`, ""];
      for (const c of clients) {
        lines.push(`- **${c.name}** (ID: ${c.id})${c.archived ? " — _Archived_" : ""}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: handleApiError(error) }] };
    }
  }
);

// ─── Transport Setup ───────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  if (!process.env.TOGGL_API_KEY) {
    console.error("ERROR: TOGGL_API_KEY environment variable is required.");
    console.error("Find your token at: https://track.toggl.com/profile");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Toggl MCP server running via stdio");
}

async function runHTTP(): Promise<void> {
  if (!process.env.TOGGL_API_KEY) {
    console.error("ERROR: TOGGL_API_KEY environment variable is required.");
    console.error("Find your token at: https://track.toggl.com/profile");
    process.exit(1);
  }

  const app = express();
  app.use(express.json());

  // Health check
  app.get("/", (_req, res) => {
    res.json({ status: "ok", server: "toggl-mcp-server", version: "1.0.0" });
  });

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(`Toggl MCP server running at http://localhost:${port}/mcp`);
  });
}

// Choose transport based on environment
const transport = process.env.TRANSPORT ?? "http";
if (transport === "stdio") {
  runStdio().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
} else {
  runHTTP().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
