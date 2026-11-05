// A01 personality-v2 switch. Default ON.
// Per implementation-plan 7.1, turning this off must NOT reconnect any legacy random-hostility
// branch. The old random annoyed path was removed from production in A01-rework1; this module
// only answers "is the new personality behavior enabled?".
export const PERSONALITY_V2_DEFAULT = true;

export function personalityV2Enabled(cfg) {
  const v = cfg?.socialV2?.personalityV2;
  if (!v || typeof v !== 'object') return PERSONALITY_V2_DEFAULT;
  return v.enabled !== false;
}
