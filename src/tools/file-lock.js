const fileLocks = new Map();
const fileOwners = new Map();

export function acquireFileLock(path, agentId) {
  var prev = fileLocks.get(path) || Promise.resolve();
  var resolveFn;
  var lockPromise = new Promise(function(resolve) { resolveFn = resolve; });
  var next = prev.then(function() { return lockPromise; });
  fileLocks.set(path, next);
  if (agentId) fileOwners.set(path, agentId);
  return function release() {
    if (fileOwners.get(path) === agentId) fileOwners.delete(path);
    resolveFn();
  };
}

export function getFileOwner(path) {
  return fileOwners.get(path) || null;
}

export function waitForFileLock(path) {
  return fileLocks.get(path) || Promise.resolve();
}

export function clearFileOwner(path, agentId) {
  if (fileOwners.get(path) === agentId) fileOwners.delete(path);
}

export function clearAllFileOwners(agentId) {
  for (var [path, owner] of fileOwners) {
    if (owner === agentId) fileOwners.delete(path);
  }
}
