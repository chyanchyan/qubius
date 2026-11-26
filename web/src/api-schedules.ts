import { request } from "./api";

export const SCHEDULE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ScheduleEffort = (typeof SCHEDULE_EFFORTS)[number];

/** 一次到点运行会用固定 prompt 新建一个对话，所以每条日程都有独立目录。 */
export interface Schedule {
  id: string;
  projectId: string;
  prompt: string;
  providerId: string;
  model: string;
  effort: ScheduleEffort;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastError?: string;
}

export interface ScheduleProvider {
  id: string;
  name: string;
  models: string[];
}

export interface ScheduleSettings {
  providers: ScheduleProvider[];
  effort: ScheduleEffort;
}

export interface CreateScheduleInput {
  prompt: string;
  providerId: string;
  model: string;
  effort: ScheduleEffort;
  intervalMinutes: number;
}

export interface SchedulePatch {
  enabled?: boolean;
  intervalMinutes?: number;
  prompt?: string;
}

const ACTION_TIMEOUT_MS = 180_000;

export function getSchedules(projectId: string, signal?: AbortSignal): Promise<{ schedules: Schedule[] }> {
  return request<{ schedules: Schedule[] }>(`/api/projects/${projectId}/schedules`, undefined, signal);
}

export function createSchedule(
  projectId: string,
  body: CreateScheduleInput,
  signal?: AbortSignal,
): Promise<{ schedule: Schedule }> {
  return request<{ schedule: Schedule }>(
    `/api/projects/${projectId}/schedules`,
    { method: "POST", body: JSON.stringify(body) },
    signal,
  );
}

export function updateSchedule(
  projectId: string,
  scheduleId: string,
  patch: SchedulePatch,
  signal?: AbortSignal,
): Promise<{ schedule: Schedule }> {
  return request<{ schedule: Schedule }>(
    `/api/projects/${projectId}/schedules/${scheduleId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    signal,
  );
}

export function deleteSchedule(
  projectId: string,
  scheduleId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/projects/${projectId}/schedules/${scheduleId}`, { method: "DELETE" }, signal);
}

export function runSchedule(
  projectId: string,
  scheduleId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; sessionId?: string }> {
  return request<{ ok: true; sessionId?: string }>(
    `/api/projects/${projectId}/schedules/${scheduleId}/run`,
    { method: "POST", body: "{}" },
    signal,
    ACTION_TIMEOUT_MS,
  );
}

export function getScheduleSettings(signal?: AbortSignal): Promise<ScheduleSettings> {
  return request<ScheduleSettings>("/api/settings", undefined, signal);
}
