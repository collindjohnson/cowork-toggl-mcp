import axios, { AxiosError, AxiosInstance } from "axios";
import { TOGGL_API_BASE_URL } from "../constants.js";

let client: AxiosInstance | null = null;

export function getTogglClient(): AxiosInstance {
  if (client) return client;

  const apiKey = process.env.TOGGL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TOGGL_API_KEY environment variable is required. " +
        "Find your API token at https://track.toggl.com/profile"
    );
  }

  // Toggl uses Basic Auth: API token as username, "api_token" as password
  const encoded = Buffer.from(`${apiKey}:api_token`).toString("base64");

  client = axios.create({
    baseURL: TOGGL_API_BASE_URL,
    timeout: 30000,
    headers: {
      Authorization: `Basic ${encoded}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  return client;
}

export function handleApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      switch (error.response.status) {
        case 400:
          return `Error: Bad request — ${JSON.stringify(error.response.data)}. Check your parameters.`;
        case 401:
          return "Error: Authentication failed. Check your TOGGL_API_KEY is correct.";
        case 403:
          return "Error: Permission denied. You don't have access to this resource.";
        case 404:
          return "Error: Resource not found. Check the ID is correct.";
        case 429:
          return "Error: Rate limit exceeded. Please wait before making more requests.";
        case 500:
          return "Error: Toggl server error. Please try again later.";
        default:
          return `Error: API request failed with status ${error.response.status}: ${JSON.stringify(error.response.data)}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    } else if (error.code === "ENOTFOUND") {
      return "Error: Cannot reach Toggl API. Check your network connection.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export async function togglGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const response = await getTogglClient().get<T>(path, { params });
  return response.data;
}

export async function togglPost<T>(path: string, data: unknown): Promise<T> {
  const response = await getTogglClient().post<T>(path, data);
  return response.data;
}

export async function togglPut<T>(path: string, data: unknown): Promise<T> {
  const response = await getTogglClient().put<T>(path, data);
  return response.data;
}

export async function togglPatch<T>(path: string, data?: unknown): Promise<T> {
  const response = await getTogglClient().patch<T>(path, data);
  return response.data;
}

export async function togglDelete(path: string): Promise<void> {
  await getTogglClient().delete(path);
}

/** Format a duration in seconds to a human-readable string */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "Running...";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Format an ISO timestamp to a readable local string */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
