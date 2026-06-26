import config from "../config/index.js";

const COMPLEX_PATTERNS = [
  /\b(build|create|write|code|script|deploy|install|configure|setup|fix|debug|update|modify|refactor|implement|migrate)\b/i,
  /\b(ssh|docker|systemd|nginx|proxmox|cloudflare|github|server|database|api)\b/i,
  /```/,
  /\b(can you|could you|please|help me|i need you to)\b.*\b(make|build|write|create|set up|fix|change|update|check)\b/i,
];

export function isComplex(message) {
  return COMPLEX_PATTERNS.some((p) => p.test(message));
}

export function pickModel(message, authorId) {
  return config.ai.models.complex;
}
