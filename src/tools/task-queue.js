import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "../config/paths.js";

// State lives in AIROUTER_HOME/data (NOT the install dir) so fresh clones work.
const QUEUE_FILE = join(DATA_DIR, "task-queue.json");

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(tasks) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(tasks, null, 2), "utf8");
}

export function addTask(description, priority = "normal", assignee = "azula") {
  const tasks = loadQueue();
  const task = {
    id: randomUUID().substring(0, 8),
    description,
    priority,
    assignee,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  tasks.push(task);
  saveQueue(tasks);
  return task;
}

export function listTasks(filter = {}) {
  const tasks = loadQueue();
  return tasks.filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.assignee && t.assignee !== filter.assignee) return false;
    return true;
  });
}

export function updateTask(taskId, updates) {
  const tasks = loadQueue();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  if (updates.status === "in_progress" && !task.startedAt) {
    task.startedAt = new Date().toISOString();
  }
  if (updates.status === "completed") {
    task.completedAt = new Date().toISOString();
  }
  saveQueue(tasks);
  return task;
}

export function getTask(taskId) {
  return loadQueue().find((t) => t.id === taskId) || null;
}

export function deleteTask(taskId) {
  const tasks = loadQueue();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveQueue(tasks);
  return true;
}

export function getStalledTasks(maxAgeMs = 600000) {
  const now = Date.now();
  return loadQueue().filter((t) => {
    if (t.status !== "in_progress") return false;
    const started = new Date(t.startedAt || t.updatedAt).getTime();
    return now - started > maxAgeMs;
  });
}
