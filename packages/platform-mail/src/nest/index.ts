// Must stay first: it throws a readable message when a peer is missing, before the module that
// needs the peer is loaded (compiled CommonJS runs imports in order).
import './require-peers';

export * from './mail.module';
export * from './telemetry';
