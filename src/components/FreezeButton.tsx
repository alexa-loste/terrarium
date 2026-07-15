import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import Button from './buttons/Button';
import { useIsAdmin } from '../hooks/useRole';

export default function FreezeButton() {
  const isAdmin = useIsAdmin();
  const stopAllowed = useQuery(api.testing.stopAllowed) ?? false;
  const defaultWorld = useQuery(api.world.defaultWorldStatus);

  const frozen = defaultWorld?.status === 'stoppedByDeveloper';

  const unfreeze = useMutation(api.testing.resume);
  const freeze = useMutation(api.testing.stop);

  const flipSwitch = async () => {
    if (frozen) {
      console.log('Unfreezing');
      await unfreeze();
    } else {
      console.log('Freezing');
      await freeze();
    }
  };

  // v2.2 — only the admin can freeze/unfreeze; viewers (T) never see this control.
  return !isAdmin || !stopAllowed ? null : (
    <>
      <Button
        onClick={flipSwitch}
        className="hidden lg:block"
        title="When freezing a world, the agents will take some time to stop what they are doing before they become frozen. "
        imgUrl="/assets/star.svg"
      >
        {frozen ? 'Unfreeze' : 'Freeze'}
      </Button>
    </>
  );
}
