// Thin facade over http that forces https protocol on client requests


import {
  Server,
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  createServer,
  STATUS_CODES,
  METHODS,
  getServer,
  getAllServers,
  setServerListenCallback,
  setServerCloseCallback,
  _buildClientRequest,
  Agent,
  globalAgent,
} from './http.js';

import type { ConnectionOptions, AgentConfig } from './http.js';

// Re-export all shared types and classes under HTTPS naming
export {
  Server,
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  createServer,
  STATUS_CODES,
  METHODS,
  getServer,
  getAllServers,
  setServerListenCallback,
  setServerCloseCallback,
  Agent,
  globalAgent,
};

export type { ConnectionOptions, AgentConfig };

export function request(
  target: string | URL | ConnectionOptions,
  optsOrCb?: ConnectionOptions | ((res: IncomingMessage) => void),
  cb?: (res: IncomingMessage) => void
): ClientRequest {
  return _buildClientRequest(target, optsOrCb, cb, 'https');
}

export function get(
  target: string | URL | ConnectionOptions,
  optsOrCb?: ConnectionOptions | ((res: IncomingMessage) => void),
  cb?: (res: IncomingMessage) => void
): ClientRequest {
  const cr = _buildClientRequest(target, optsOrCb, cb, 'https');
  cr.end();
  return cr;
}

export default {
  Server,
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  createServer,
  request,
  get,
  STATUS_CODES,
  METHODS,
  getServer,
  getAllServers,
  setServerListenCallback,
  setServerCloseCallback,
  Agent,
  globalAgent,
};
