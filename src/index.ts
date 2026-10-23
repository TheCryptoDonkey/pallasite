// The shared controller protocol files (controller-types.ts and its siblings) are copied
// from forgesworn/joystick packages/protocol/src, where the entry point is index.ts and
// the siblings import from './index.js'. This one-line shim lets them stay byte-identical
// here, which scripts/check-protocol-sync.sh in that repository relies on.
export * from './controller-types.js';
