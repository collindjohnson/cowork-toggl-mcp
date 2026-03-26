export interface TogglWorkspace {
  id: number;
  name: string;
  premium: boolean;
  admin: boolean;
  default_hourly_rate: number;
  default_currency: string;
  only_admins_may_create_projects: boolean;
  only_admins_see_billable_rates: boolean;
  rounding: number;
  rounding_minutes: number;
  at: string;
  logo_url?: string;
}

export interface TogglUser {
  id: number;
  email: string;
  fullname: string;
  timezone: string;
  default_workspace_id: number;
  beginning_of_week: number;
  image_url: string;
  created_at: string;
  updated_at: string;
  openid_enabled: boolean;
  country_id: number;
}

export interface TogglTimeEntry {
  id: number;
  workspace_id: number;
  project_id: number | null;
  task_id: number | null;
  billable: boolean;
  start: string;
  stop: string | null;
  duration: number;
  description: string | null;
  tags: string[];
  tag_ids: number[];
  duronly: boolean;
  at: string;
  server_deleted_at: string | null;
  user_id: number;
  uid: number;
  wid: number;
  pid: number | null;
}

export interface TogglProject {
  id: number;
  workspace_id: number;
  client_id: number | null;
  name: string;
  is_private: boolean;
  active: boolean;
  at: string;
  created_at: string;
  color: string;
  billable: boolean | null;
  template: boolean | null;
  auto_estimates: boolean | null;
  estimated_hours: number | null;
  rate: number | null;
  rate_last_updated: string | null;
  currency: string | null;
  recurring: boolean;
  recurring_parameters: unknown | null;
  current_period: unknown | null;
  fixed_fee: number | null;
  actual_hours: number;
  wid: number;
  cid: number | null;
}

export interface TogglClient {
  id: number;
  wid: number;
  archived: boolean;
  name: string;
  at: string;
}

export interface PaginatedResponse<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
}
