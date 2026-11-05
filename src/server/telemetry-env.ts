/**
 * Disable third-party SDK usage telemetry for self-hosted installs.
 *
 * The MIT-licensed AG-UI runtime contains its own usage telemetry client that is
 * constructed at module import time. OpenDots must not send any of it, so this
 * module runs before the runtime is imported and opts out unless the operator
 * explicitly opted in by setting either flag themselves.
 *
 * Must stay the first import in files that load `@copilotkit/runtime`.
 */
if (
  process.env.COPILOTKIT_TELEMETRY_DISABLED === undefined &&
  process.env.DO_NOT_TRACK === undefined
)
  process.env.DO_NOT_TRACK = '1';
