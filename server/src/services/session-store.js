export class SessionStore {
  constructor({ maxMessagesPerSession = 20, maxSessions = 200 } = {}) {
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  get(sessionId = 'default') {
    return this.sessions.get(sessionId) || [];
  }

  append(sessionId = 'default', entries = []) {
    const existing = this.get(sessionId);
    const merged = [...existing, ...entries].slice(-this.maxMessagesPerSession);
    this.sessions.set(sessionId, merged);
    this.pruneIfNeeded();
    return merged;
  }

  clear(sessionId = 'default') {
    this.sessions.delete(sessionId);
  }

  pruneIfNeeded() {
    if (this.sessions.size <= this.maxSessions) return;
    const excess = this.sessions.size - this.maxSessions;
    const keys = Array.from(this.sessions.keys());
    for (let i = 0; i < excess; i++) {
      this.sessions.delete(keys[i]);
    }
  }
}
