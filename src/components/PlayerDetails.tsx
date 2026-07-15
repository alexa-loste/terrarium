import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import closeImg from '../../assets/close.svg';
import { SelectElement } from './Player';
import { Messages } from './Messages';
import { toastOnError } from '../toasts';
import { useSendInput } from '../hooks/sendInput';
import { Player } from '../../convex/aiTown/player';
import { GameId } from '../../convex/aiTown/ids';
import { ServerGame } from '../hooks/serverGame';
import { jobLabel } from '../../data/work';
import { planWhenLabel } from '../../data/plans';
import { stressBand, momentumBand, stressEmoji, momentumEmoji } from '../../data/mood';

// A collapsible panel section: the brown header bar is a toggle (collapsed by default), with
// an optional count badge so you can see what's inside without opening it.
function Section({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="pointer-events-auto w-full cursor-pointer"
        title={open ? 'Click to collapse' : 'Click to expand'}
      >
        <div className="flex items-center gap-2 bg-brown-700 px-3 py-1.5 text-lg shadow-solid">
          <span
            className={`text-sm text-brown-300 transition-transform ${open ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
          <span className="flex-1 text-left">{title}</span>
          {typeof badge === 'number' && badge > 0 && (
            <span className="rounded-full bg-black/30 px-2 text-xs text-brown-200">{badge}</span>
          )}
        </div>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export default function PlayerDetails({
  worldId,
  engineId,
  game,
  playerId,
  setSelectedElement,
  scrollViewRef,
}: {
  worldId: Id<'worlds'>;
  engineId: Id<'engines'>;
  game: ServerGame;
  playerId?: GameId<'players'>;
  setSelectedElement: SelectElement;
  scrollViewRef: React.RefObject<HTMLDivElement>;
}) {
  const humanTokenIdentifier = useQuery(api.world.userStatus, { worldId });

  const players = [...game.world.players.values()];
  const humanPlayer = players.find((p) => p.human === humanTokenIdentifier);
  const humanConversation = humanPlayer ? game.world.playerConversation(humanPlayer) : undefined;
  // Always select the other player if we're in a conversation with them.
  if (humanPlayer && humanConversation) {
    const otherPlayerIds = [...humanConversation.participants.keys()].filter(
      (p) => p !== humanPlayer.id,
    );
    playerId = otherPlayerIds[0];
  }

  const player = playerId && game.world.players.get(playerId);
  const playerConversation = player && game.world.playerConversation(player);

  const previousConversation = useQuery(
    api.world.previousConversation,
    playerId ? { worldId, playerId } : 'skip',
  );

  const inbox = useQuery(api.directMessages.listInbox, playerId ? { worldId, playerId } : 'skip');

  const relationships = useQuery(
    api.relationships.getRelationships,
    playerId ? { worldId, playerId } : 'skip',
  );

  const works = useQuery(
    api.artifacts.listByAuthor,
    playerId ? { worldId, authorPlayerId: playerId } : 'skip',
  );

  const journal = useQuery(api.journal.listByAuthor, playerId ? { worldId, playerId } : 'skip');

  const beliefs = useQuery(api.beliefs.getForPlayer, playerId ? { worldId, playerId } : 'skip');

  const work = useQuery(api.work.getForPlayer, playerId ? { worldId, playerId } : 'skip');

  const plans = useQuery(api.plans.getForPlayer, playerId ? { worldId, playerId } : 'skip');
  const clock = useQuery(api.clock.getClock, { worldId });
  const currentDay = clock?.time.day ?? 0;

  const drives = useQuery(api.drives.getForPlayer, playerId ? { worldId, playerId } : 'skip');
  const goals = useQuery(api.goals.getForPlayer, playerId ? { worldId, playerId } : 'skip');
  const factions = useQuery(
    api.factions.getForPlayer,
    playerId ? { worldId, playerId } : 'skip',
  );
  const gossip = useQuery(api.gossip.forSubject, playerId ? { worldId, playerId } : 'skip');
  const civic = useQuery(api.civics.activeIssue, { worldId });
  const lastCivic = useQuery(api.civics.lastResolved, { worldId });
  const reciprocity = useQuery(api.reciprocity.forPlayer, playerId ? { worldId, playerId } : 'skip');
  const allVitals = useQuery(api.agentVitals.listVitals, { worldId });
  const myVitals = playerId ? allVitals?.find((v) => v.playerId === playerId) : undefined;

  const reputation = useQuery(api.relationships.listReputation, { worldId });
  const rankedReputation = reputation
    ? [...reputation].sort((a, b) => b.prestige - a.prestige)
    : [];
  const myPrestige = playerId
    ? reputation?.find((r) => r.playerId === playerId)?.prestige
    : undefined;
  const myRank = playerId ? rankedReputation.findIndex((r) => r.playerId === playerId) + 1 : 0;

  const playerDescription = playerId && game.playerDescriptions.get(playerId);

  const startConversation = useSendInput(engineId, 'startConversation');
  const acceptInvite = useSendInput(engineId, 'acceptInvite');
  const rejectInvite = useSendInput(engineId, 'rejectInvite');
  const leaveConversation = useSendInput(engineId, 'leaveConversation');

  if (!playerId) {
    return (
      <div className="h-full text-xl flex text-center items-center p-4">
        Click on an agent on the map to see chat history.
      </div>
    );
  }
  if (!player) {
    return null;
  }
  const isMe = humanPlayer && player.id === humanPlayer.id;
  const canInvite = !isMe && !playerConversation && humanPlayer && !humanConversation;
  const sameConversation =
    !isMe &&
    humanPlayer &&
    humanConversation &&
    playerConversation &&
    humanConversation.id === playerConversation.id;

  const humanStatus =
    humanPlayer && humanConversation && humanConversation.participants.get(humanPlayer.id)?.status;
  const playerStatus = playerConversation && playerConversation.participants.get(playerId)?.status;

  const haveInvite = sameConversation && humanStatus?.kind === 'invited';
  const waitingForAccept =
    sameConversation && playerConversation.participants.get(playerId)?.status.kind === 'invited';
  const waitingForNearby =
    sameConversation && playerStatus?.kind === 'walkingOver' && humanStatus?.kind === 'walkingOver';

  const inConversationWithMe =
    sameConversation &&
    playerStatus?.kind === 'participating' &&
    humanStatus?.kind === 'participating';

  const onStartConversation = async () => {
    if (!humanPlayer || !playerId) {
      return;
    }
    console.log(`Starting conversation`);
    await toastOnError(startConversation({ playerId: humanPlayer.id, invitee: playerId }));
  };
  const onAcceptInvite = async () => {
    if (!humanPlayer || !humanConversation || !playerId) {
      return;
    }
    await toastOnError(
      acceptInvite({
        playerId: humanPlayer.id,
        conversationId: humanConversation.id,
      }),
    );
  };
  const onRejectInvite = async () => {
    if (!humanPlayer || !humanConversation) {
      return;
    }
    await toastOnError(
      rejectInvite({
        playerId: humanPlayer.id,
        conversationId: humanConversation.id,
      }),
    );
  };
  const onLeaveConversation = async () => {
    if (!humanPlayer || !inConversationWithMe || !humanConversation) {
      return;
    }
    await toastOnError(
      leaveConversation({
        playerId: humanPlayer.id,
        conversationId: humanConversation.id,
      }),
    );
  };
  // const pendingSuffix = (inputName: string) =>
  //   [...inflightInputs.values()].find((i) => i.name === inputName) ? ' opacity-50' : '';

  const pendingSuffix = (s: string) => '';
  return (
    <>
      <div className="flex gap-4">
        <div className="box w-3/4 sm:w-full mr-auto">
          <h2 className="bg-brown-700 p-2 font-display text-2xl sm:text-4xl tracking-wider shadow-solid text-center">
            {playerDescription?.name}
          </h2>
        </div>
        <a
          className="button text-white shadow-solid text-2xl cursor-pointer pointer-events-auto"
          onClick={() => setSelectedElement(undefined)}
        >
          <h2 className="h-full bg-clay-700">
            <img className="w-4 h-4 sm:w-5 sm:h-5" src={closeImg} />
          </h2>
        </a>
      </div>
      {canInvite && (
        <a
          className={
            'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
            pendingSuffix('startConversation')
          }
          onClick={onStartConversation}
        >
          <div className="h-full bg-clay-700 text-center">
            <span>Start conversation</span>
          </div>
        </a>
      )}
      {waitingForAccept && (
        <a className="mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto opacity-50">
          <div className="h-full bg-clay-700 text-center">
            <span>Waiting for accept...</span>
          </div>
        </a>
      )}
      {waitingForNearby && (
        <a className="mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto opacity-50">
          <div className="h-full bg-clay-700 text-center">
            <span>Walking over...</span>
          </div>
        </a>
      )}
      {inConversationWithMe && (
        <a
          className={
            'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
            pendingSuffix('leaveConversation')
          }
          onClick={onLeaveConversation}
        >
          <div className="h-full bg-clay-700 text-center">
            <span>Leave conversation</span>
          </div>
        </a>
      )}
      {haveInvite && (
        <>
          <a
            className={
              'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
              pendingSuffix('acceptInvite')
            }
            onClick={onAcceptInvite}
          >
            <div className="h-full bg-clay-700 text-center">
              <span>Accept</span>
            </div>
          </a>
          <a
            className={
              'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
              pendingSuffix('rejectInvite')
            }
            onClick={onRejectInvite}
          >
            <div className="h-full bg-clay-700 text-center">
              <span>Reject</span>
            </div>
          </a>
        </>
      )}
      {!playerConversation && player.activity && player.activity.until > Date.now() && (
        <div className="box flex-grow mt-6">
          <h2 className="bg-brown-700 text-base sm:text-lg text-center">
            {player.activity.description}
          </h2>
        </div>
      )}
      <Section title="📖 Bio" defaultOpen>
        <p className="bg-brown-700 p-2 text-base leading-tight sm:text-sm">
          {!isMe && playerDescription?.description}
          {isMe && <i>This is you!</i>}
          {!isMe && inConversationWithMe && (
            <>
              <br />
              <br />(<i>Conversing with you!</i>)
            </>
          )}
        </p>
      </Section>
      {!isMe && playerConversation && playerStatus?.kind === 'participating' && (
        <Messages
          worldId={worldId}
          engineId={engineId}
          inConversationWithMe={inConversationWithMe ?? false}
          conversation={{ kind: 'active', doc: playerConversation }}
          humanPlayer={humanPlayer}
          scrollViewRef={scrollViewRef}
        />
      )}
      {!playerConversation && previousConversation && (
        <Section title="💬 Previous conversation">
          <Messages
            worldId={worldId}
            engineId={engineId}
            inConversationWithMe={false}
            conversation={{ kind: 'archived', doc: previousConversation }}
            humanPlayer={humanPlayer}
            scrollViewRef={scrollViewRef}
          />
        </Section>
      )}
      {typeof myPrestige === 'number' && (
        <div className="box flex-grow mt-6">
          <h2 className="bg-brown-700 text-base text-center">
            ⭐ Standing in town: {myPrestige > 0 ? '+' : ''}
            {myPrestige}
            {myRank > 0 && rankedReputation.length > 1 && (
              <span className="text-brown-300">
                {' '}
                · #{myRank} of {rankedReputation.length}
              </span>
            )}
          </h2>
        </div>
      )}
      {work && playerDescription && (
        <div className="box flex-grow mt-4">
          <h2 className="bg-brown-700 text-base text-center">
            💼 {jobLabel(playerDescription.name)}
            {work.quota != null && (
              <span className="text-brown-300">
                {' '}
                · {work.deliverablesThisCycle}/{work.quota} this cycle
              </span>
            )}
            {work.behind ? (
              <span className="text-red-300"> · behind ⚠️</span>
            ) : work.missedCount === 0 ? (
              <span className="text-emerald-300"> · on track</span>
            ) : null}
          </h2>
        </div>
      )}
      {myVitals && (
        <Section title="🌤️ Inner state" defaultOpen>
          <div className="space-y-2 bg-brown-700 px-2 py-2 text-sm">
            <div>
              <div className="flex items-baseline gap-1.5 text-xs">
                <span>{stressEmoji(myVitals.stress)} Stress</span>
                <span className="ml-auto text-brown-300">{stressBand(myVitals.stress)}</span>
              </div>
              <div className="my-0.5 h-1.5 w-full overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full bg-rose-400"
                  style={{ width: `${Math.max(0, Math.min(100, myVitals.stress))}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex items-baseline gap-1.5 text-xs">
                <span>{momentumEmoji(myVitals.momentum)} Momentum</span>
                <span className="ml-auto text-brown-300">{momentumBand(myVitals.momentum)}</span>
              </div>
              <div className="my-0.5 h-1.5 w-full overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full bg-emerald-400"
                  style={{ width: `${Math.max(0, Math.min(100, myVitals.momentum))}%` }}
                />
              </div>
            </div>
            <div className="flex items-baseline gap-3 text-[11px] text-brown-200">
              <span>🎉 Leisure {Math.round(myVitals.leisure)}</span>
              <span>🫂 Social {Math.round(myVitals.social)}</span>
            </div>
            {drives && drives.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {drives.slice(0, 4).map((d) => (
                  <span
                    key={d.key}
                    className="rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-brown-100"
                    title={`${d.label} · ${d.weight}`}
                  >
                    {d.key} {d.weight}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}
      {goals && goals.length > 0 && (
        <Section
          title="🎯 Goals"
          badge={goals.filter((g) => g.status === 'active').length}
          defaultOpen
        >
          <div className="space-y-1">
            {goals.map((g) => {
              const overdue = g.status === 'active' && currentDay > g.dueDay;
              const statusEmoji =
                g.status === 'done' ? '✅' : g.status === 'missed' ? '❌' : overdue ? '⏰' : '•';
              return (
                <div
                  key={g._id}
                  className={`px-2 py-1 text-sm ${
                    g.tier === 'long'
                      ? 'border-l-4 border-l-amber-400 bg-brown-700'
                      : 'bg-brown-800'
                  } ${g.status !== 'active' ? 'opacity-70' : ''}`}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span>{g.tier === 'long' ? '🌟' : statusEmoji}</span>
                    <span className="leading-snug">{g.text}</span>
                    <span className="ml-auto whitespace-nowrap text-[10px] text-brown-300">
                      {g.status === 'active'
                        ? planWhenLabel(g.dueDay, currentDay).replace('today', 'due today')
                        : g.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {plans && plans.length > 0 && (
        <Section
          title="📅 Plans"
          badge={plans.filter((p) => p.status === 'upcoming').length}
          defaultOpen
        >
          <div className="space-y-1">
            {plans.slice(0, 10).map((p) => {
              const others = p.attendees
                .filter((a) => a.playerId !== playerId)
                .map((a) => a.playerName);
              const past = p.status !== 'upcoming';
              return (
                <div
                  key={p._id}
                  className={`border-l-4 px-2 py-1 text-sm ${
                    past
                      ? 'border-l-brown-500 bg-brown-800 opacity-60'
                      : 'border-l-emerald-400 bg-brown-700'
                  }`}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-bold leading-tight">{p.title}</span>
                    <span className="ml-auto text-[10px] text-brown-300">
                      {past ? 'past' : planWhenLabel(p.day, currentDay, p.hour)}
                    </span>
                  </div>
                  <div className="text-xs text-brown-200">
                    {p.placeName ? `${p.placeName} · ` : ''}day {p.day}
                    {others.length ? ` · with ${others.join(', ')}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {civic && (
        <Section title="🏛️ Town vote" defaultOpen>
          <div className="border-l-4 border-l-amber-400 bg-brown-700 px-2 py-1.5">
            <div className="font-bold leading-tight">{civic.title}</div>
            <div className="mt-0.5 text-xs text-brown-200">{civic.text}</div>
            {/* for / against weight bar */}
            <div className="mt-1.5 flex h-2.5 w-full overflow-hidden rounded bg-brown-900">
              <div
                className="h-full bg-emerald-400"
                style={{
                  width: `${
                    (100 * civic.forWeight) / Math.max(1, civic.forWeight + civic.againstWeight)
                  }%`,
                }}
              />
              <div
                className="h-full bg-rose-400"
                style={{
                  width: `${
                    (100 * civic.againstWeight) / Math.max(1, civic.forWeight + civic.againstWeight)
                  }%`,
                }}
              />
            </div>
            <div className="mt-0.5 flex justify-between text-[10px] text-brown-300">
              <span>for {civic.supporters} ({civic.forWeight})</span>
              <span className="font-bold capitalize text-brown-100">{civic.leaning}</span>
              <span>({civic.againstWeight}) {civic.opposers} against</span>
            </div>
            <div className="mt-0.5 text-[10px] text-brown-400">
              {civic.proposerName} proposed it · decided day {civic.resolvesDay}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {civic.stances.map((s) => (
                <span
                  key={s.name}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    s.stance === 'support'
                      ? 'bg-emerald-900 text-emerald-200'
                      : s.stance === 'oppose'
                        ? 'bg-rose-900 text-rose-200'
                        : 'bg-brown-800 text-brown-300'
                  }`}
                  title={`${s.stance} (${s.weight})`}
                >
                  {s.name}
                </span>
              ))}
            </div>
          </div>
        </Section>
      )}
      {!civic && lastCivic && (
        <Section title="🏛️ Town vote">
          <div className="px-2 py-1 text-sm text-brown-200">
            Last decided: <span className="font-bold">{lastCivic.title}</span> —{' '}
            <span className={lastCivic.passed ? 'text-emerald-300' : 'text-rose-300'}>
              {lastCivic.passed ? 'passed' : 'failed'}
            </span>{' '}
            (day {lastCivic.resolvedDay}).
          </div>
        </Section>
      )}
      {factions && factions.length > 0 && (
        <Section title="🤝 Allegiances" badge={factions.length} defaultOpen>
          <div className="space-y-1.5">
            {factions.map((f) => {
              // Commitment bar color tracks the band: core/member warm, curious cooler.
              const strong = f.band === 'core' || f.band === 'member';
              return (
                <div
                  key={f.factionId}
                  className={`border-l-4 px-2 py-1.5 text-sm ${
                    strong ? 'border-l-amber-400 bg-brown-700' : 'border-l-brown-500 bg-brown-800'
                  }`}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-bold leading-tight">{f.name}</span>
                    {f.role === 'founder' && (
                      <span className="text-[10px] text-amber-300">founder</span>
                    )}
                    <span className="ml-auto text-[10px] capitalize text-brown-300">{f.band}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-brown-200">{f.premise}</div>
                  {/* commitment bar */}
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-brown-900">
                    <div
                      className={`h-full ${strong ? 'bg-amber-400' : 'bg-brown-400'}`}
                      style={{ width: `${f.commitment}%` }}
                    />
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5 text-[10px] text-brown-300">
                    <span>{f.poleLabel}</span>
                    <span className="ml-auto">
                      {f.commitment}% in{f.rival ? ` · vs ${f.rival}` : ''}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {beliefs && beliefs.length > 0 && (
        <Section title="🧭 Beliefs" badge={beliefs.length}>
          <div className="space-y-1.5">
            {beliefs.map((b) => {
              const recentlyShifted =
                !!b.lastShiftAt && Date.now() - b.lastShiftAt < 15 * 60 * 1000;
              const barColor =
                b.conviction > 66
                  ? 'bg-rose-400'
                  : b.conviction > 40
                    ? 'bg-amber-400'
                    : 'bg-sky-400';
              return (
                <div key={b._id} className="bg-brown-700 px-2 py-1 text-sm">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-brown-300">
                      {b.topic}
                    </span>
                    {recentlyShifted && (
                      <span className="text-[10px] text-yellow-300" title="recently shifted">
                        ⟳ shifting
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-brown-300">
                      {Math.round(b.conviction)}
                    </span>
                  </div>
                  <div className="my-0.5 h-1 w-full overflow-hidden rounded-full bg-black/40">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${Math.max(0, Math.min(100, b.conviction))}%` }}
                    />
                  </div>
                  <p className="leading-snug text-brown-100">{b.statement}</p>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {relationships && relationships.length > 0 && (
        <Section title="🫶 Relationships" badge={relationships.length}>
          <div className="space-y-1">
            {relationships.slice(0, 6).map((r) => {
              const name =
                game.playerDescriptions.get(r.toPlayerId as GameId<'players'>)?.name ?? 'someone';
              const a = r.affinity;
              const label =
                a >= 80
                  ? 'close'
                  : a >= 65
                    ? 'warm'
                    : a >= 55
                      ? 'friendly'
                      : a > 45
                        ? 'neutral'
                        : a >= 30
                          ? 'cool'
                          : 'tense';
              return (
                <div
                  key={r.toPlayerId}
                  className="flex items-center gap-2 bg-brown-700 px-2 py-1 text-sm"
                >
                  <span className="font-bold">{name}</span>
                  {r.romantic > 20 && <span title="a spark">❤️</span>}
                  <span className="ml-auto text-xs text-brown-200">{label}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {reciprocity &&
        (reciprocity.owe.length > 0 ||
          reciprocity.owed.length > 0 ||
          reciprocity.recent.length > 0) && (
          <Section title="🤝 Favors & debts">
            <div className="space-y-1.5 text-sm">
              {reciprocity.owe.map((d) => (
                <div key={`owe-${d.name}`} className="flex justify-between text-rose-200">
                  <span>owes {d.name}</span>
                  <span className="font-bold tabular-nums">{d.amount}</span>
                </div>
              ))}
              {reciprocity.owed.map((d) => (
                <div key={`owed-${d.name}`} className="flex justify-between text-emerald-200">
                  <span>{d.name} owes them</span>
                  <span className="font-bold tabular-nums">{d.amount}</span>
                </div>
              ))}
              {reciprocity.recent.length > 0 && (
                <div className="mt-1 border-t border-brown-700 pt-1.5 text-xs text-brown-300">
                  {reciprocity.recent.map((e) => (
                    <div key={e.id} className="flex items-baseline gap-1">
                      <span>
                        {e.kind === 'gift'
                          ? '🎁'
                          : e.kind === 'loan'
                            ? '🪙'
                            : e.kind === 'repay'
                              ? '↩️'
                              : '🤲'}
                      </span>
                      <span>
                        {e.fromName} → {e.toName}
                        {e.amount ? ` · ${e.amount}` : ''}
                      </span>
                      <span className="ml-auto text-[10px] text-brown-400">day {e.day}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )}
      {gossip && gossip.length > 0 && (
        <Section title="🗣️ Word going around" badge={gossip.length}>
          <div className="space-y-1.5">
            {gossip.map((g) => (
              <div
                key={g.id}
                className={`border-l-4 px-2 py-1 text-sm ${
                  g.valence >= 0 ? 'border-l-emerald-400 bg-brown-700' : 'border-l-rose-400 bg-brown-800'
                }`}
              >
                <div className="italic text-brown-100">"{g.line}"</div>
                <div className="mt-0.5 text-[10px] text-brown-300">
                  {g.speakerName} → {g.listenerName} · day {g.day}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {works && works.length > 0 && (
        <Section title="📚 Works" badge={works.length}>
          <div className="space-y-1">
            {works.slice(0, 8).map((w) => (
              <div key={w._id} className="bg-brown-700 px-2 py-1 text-sm">
                <div className="flex items-baseline gap-1.5">
                  <span>{w.emoji}</span>
                  <span className="font-bold leading-tight">{w.title}</span>
                  <span className="ml-auto text-[10px] text-brown-300">day {w.day}</span>
                </div>
                <div className="text-xs text-brown-200">{w.workType}</div>
                <p className="mt-0.5 whitespace-pre-wrap text-xs leading-snug text-brown-100">
                  {w.body}
                </p>
                {w.respondsTo && (
                  <div className="mt-0.5 text-[11px] italic text-brown-300">
                    ↳ re: {w.respondsTo}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {journal && journal.length > 0 && (
        <Section title="📔 Journal" badge={journal.length}>
          <div className="space-y-1">
            {journal.slice(0, 12).map((e) => {
              const tag: Record<string, string> = {
                reflection: '🌙 nightly',
                conversation: '💬 after talking',
                artifact: '🛠️ on the work',
                event: '📣 on the news',
                spontaneous: '✍️ unprompted',
              };
              return (
                <div
                  key={e._id}
                  className="border-l-4 border-l-sky-400 bg-brown-700 px-2 py-1 text-sm"
                >
                  <div className="flex items-baseline gap-1.5 text-[10px] text-brown-300">
                    <span>{tag[e.trigger] ?? e.trigger}</span>
                    {e.contextNote && e.trigger !== 'reflection' && (
                      <span className="italic">· {e.contextNote}</span>
                    )}
                    <span className="ml-auto">day {e.day}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap italic leading-snug text-brown-100">
                    {e.text}
                  </p>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {inbox && inbox.length > 0 && (
        <Section title="✉️ Direct messages" badge={inbox.length}>
          <div className="space-y-2">
            {inbox.map((m) => {
              const sent = m.fromPlayerId === playerId;
              const other = sent
                ? (game.playerDescriptions.get(m.toPlayerId as GameId<'players'>)?.name ??
                  'someone')
                : m.fromName;
              return (
                <div key={m._id} className="bg-brown-700 p-2 text-sm">
                  <div className="text-xs text-brown-300">
                    {sent ? `→ to ${other}` : `← from ${other}`}
                  </div>
                  <div className="whitespace-pre-wrap">{m.text}</div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}
