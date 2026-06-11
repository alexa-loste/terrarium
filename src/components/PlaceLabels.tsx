import { Graphics, Text } from '@pixi/react';
import { useCallback } from 'react';
import * as PIXI from 'pixi.js';
import { Places, Homes, Place } from '../../data/places.ts';

// "Buildings" for the semantic places + homes: a colored footprint, an icon, and a name —
// so the world reads as a city even though the underlying tilemap art is still generic.

const COLOR: Record<Place['type'], number> = {
  cafe: 0x8a5a2b,
  office: 0x3b6ea5,
  civic: 0xa07c34,
  culture: 0x8e5aa8,
  health: 0xb5443f,
  public: 0x4f8f5a,
  nightlife: 0x9a6b2e,
  home: 0x46637e,
};

const ICON_BY_ID: Record<string, string> = {
  cafe: '☕',
  coworking: '💻',
  lab: '🔬',
  cityhall: '🏛️',
  commons: '🤝',
  gallery: '🎨',
  hospital: '🏥',
  park: '🌳',
  bar: '🍺',
};

const iconFor = (p: Place) => (p.type === 'home' ? '🏠' : ICON_BY_ID[p.id] ?? '📍');

const nameStyle = new PIXI.TextStyle({
  fontFamily: '"VCR OSD Mono", monospace',
  fontSize: 22,
  fill: '#fff4d6',
  stroke: '#241a0c',
  strokeThickness: 5,
  align: 'center',
});
const homeNameStyle = new PIXI.TextStyle({
  fontFamily: '"VCR OSD Mono", monospace',
  fontSize: 18,
  fill: '#dcefff',
  stroke: '#14202c',
  strokeThickness: 5,
  align: 'center',
});
const iconStyle = new PIXI.TextStyle({ fontSize: 30 });

export default function PlaceLabels({ tileDim }: { tileDim: number }) {
  const all = [...Places, ...Homes];

  // Filled, bordered building footprints (sized to each place's "you're here" radius).
  const drawBuildings = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      for (const p of all) {
        const half = (p.radius + 0.5) * tileDim;
        const cx = p.x * tileDim + tileDim / 2;
        const cy = p.y * tileDim + tileDim / 2;
        g.lineStyle(2.5, 0x000000, 0.35);
        g.beginFill(COLOR[p.type], p.type === 'home' ? 0.34 : 0.42);
        g.drawRoundedRect(cx - half, cy - half, half * 2, half * 2, 7);
        g.endFill();
        // A darker "roof" strip across the top for a building-y feel.
        g.beginFill(COLOR[p.type], 0.55);
        g.drawRoundedRect(cx - half, cy - half, half * 2, Math.min(10, half * 0.5), 7);
        g.endFill();
      }
    },
    [tileDim],
  );

  return (
    <>
      <Graphics draw={drawBuildings} />
      {all.map((p) => {
        const cx = p.x * tileDim + tileDim / 2;
        const cy = p.y * tileDim + tileDim / 2;
        const iconScale = Math.min(1.5, 0.7 + p.radius * 0.25);
        return (
          <Text
            key={`icon-${p.id}`}
            text={iconFor(p)}
            x={cx}
            y={cy}
            scale={iconScale}
            anchor={{ x: 0.5, y: 0.5 }}
            style={iconStyle}
          />
        );
      })}
      {all.map((p) => {
        const cx = p.x * tileDim + tileDim / 2;
        const cy = p.y * tileDim + tileDim / 2;
        const half = (p.radius + 0.5) * tileDim;
        const label = p.type === 'home' ? `${p.owner}'s` : p.name;
        return (
          <Text
            key={`name-${p.id}`}
            text={label}
            x={cx}
            y={cy - half - 3}
            scale={0.5}
            anchor={{ x: 0.5, y: 1 }}
            style={p.type === 'home' ? homeNameStyle : nameStyle}
          />
        );
      })}
    </>
  );
}
