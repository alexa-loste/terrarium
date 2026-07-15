import { useMutation, useQuery } from 'convex/react';
import { useEffect } from 'react';
import { api } from '../../convex/_generated/api';
import { WORLD_HEARTBEAT_INTERVAL } from '../../convex/constants';
import { getRole } from './useRole';

export function useWorldHeartbeat() {
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;

  // v2.2 — ONLY the admin (alexa) keeps the world alive. A viewer (T) watching never heartbeats,
  // so when alexa is gone the existing idle-stop cron freezes the world ~5 min later, and a
  // viewer landing on a stopped world can't revive it (heartbeat won't restart it for them).
  const heartbeat = useMutation(api.world.heartbeatWorld);
  useEffect(() => {
    const sendHeartBeat = () => {
      if (!worldStatus || getRole() !== 'admin') {
        return;
      }
      // Don't send a heartbeat if we've observed one sufficiently close
      // to the present.
      if (Date.now() - WORLD_HEARTBEAT_INTERVAL / 2 < worldStatus.lastViewed) {
        return;
      }
      void heartbeat({ worldId: worldStatus.worldId });
    };
    sendHeartBeat();
    const id = setInterval(sendHeartBeat, WORLD_HEARTBEAT_INTERVAL);
    return () => clearInterval(id);
    // Rerun if the `worldId` changes but not `worldStatus`, since don't want to
    // resend the heartbeat whenever its last viewed timestamp changes.
  }, [worldId, heartbeat]);
}
