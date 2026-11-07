// Kinetic caption text (quality): word-by-word reveal with `pop-in` at each token's frame, page exit with
// `out-fast`, one highlight and one emphasis (`punch` + the marker) per page at most. Latin tokens are their own <bdi>
// span in the Latin face. Highlighted and emphasised words sit on the highlight marker (pack accent fill); their text
// switches to the ink colour (≥ 4.5:1 against the marker, `tokenColour`) once the marker is half grown. `KineticTextFa` sets the Persian container (`lang="fa"
// dir="rtl"`): tokens are laid out by the browser, never positioned by index, so token 0 (the first to enter) is the
// rightmost.
import React, { useContext } from 'react';
import { tokenColour } from '../contrast';
import { curveAt } from '../curves';
import type { TimelineToken } from '../timeline';
import { SplitCharsContext, useFaces } from './context';
import { Highlight } from './Highlight';

export interface KineticProps {
  frame: number;
  lines: TimelineToken[][];
  lang: 'fa' | 'en';
  sizePx: number;
  lineHeight: number;
  weight: number;
  colour: string;
  accent: string;
  exitAt: number | null;
  /** The plate behind the page (plate-highlight / plate styles), or null. */
  plate: string | null;
  display?: boolean;
}

const Token: React.FC<{ t: TimelineToken; frame: number; rtl: boolean; accent: string; colour: string; plate: string | null }> = ({ t, frame, rtl, accent, colour, plate }) => {
  const faces = useFaces();
  const split = useContext(SplitCharsContext);
  const local = frame - t.enter;
  const pop = curveAt(t.curve, local);
  const land = t.enter + 6;
  const punch = t.emphasis ? curveAt('punch', frame - land) : { scale: 1 };
  const style: React.CSSProperties = {
    display: 'inline-block',
    position: 'relative',
    opacity: pop.opacity,
    transform: `translateY(${pop.y}px) scale(${pop.scale * punch.scale})`,
    color: tokenColour(t, frame, { colour, accent, plate }),
    zIndex: 0,
  };
  const body = split && !t.latin ? [...t.text].map((ch, k) => <span key={k} style={{ display: 'inline-block' }}>{ch}</span>) : t.text;
  return (
    <span style={style} data-token={t.text} data-enter={t.enter}>
      {t.highlight || t.emphasis ? <Highlight frame={frame} landAt={land} colour={accent} rtl={rtl} /> : null}
      {t.latin ? (
        <bdi dir="ltr" style={{ fontFamily: faces.latin }}>
          {body}
        </bdi>
      ) : (
        body
      )}
    </span>
  );
};

export const KineticText: React.FC<KineticProps & { rtl?: boolean }> = (p) => {
  const faces = useFaces();
  const rtl = p.rtl ?? false;
  const exit = p.exitAt === null ? 1 : curveAt('out-fast', p.frame - p.exitAt).opacity;
  const first = p.lines[0]?.[0];
  const plateOpacity = first ? curveAt('pop-in', p.frame - first.enter).opacity : 1;
  const block = (
    <div
      lang={p.lang}
      dir={rtl ? 'rtl' : 'ltr'}
      style={{
        fontFamily: p.display ? faces.display : p.lang === 'fa' ? faces.text : faces.latin,
        fontWeight: p.weight,
        fontSize: p.sizePx,
        lineHeight: p.lineHeight,
        letterSpacing: 0,
        textAlign: 'center',
        color: p.colour,
      }}
    >
      {p.lines.map((line, l) => (
        <div key={l}>
          {line.map((t, k) => (
            <React.Fragment key={k}>
              {k > 0 ? ' ' : null}
              <Token t={t} frame={p.frame} rtl={rtl} accent={p.accent} colour={p.colour} plate={p.plate} />
            </React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
  return (
    <div style={{ opacity: exit, display: 'flex', justifyContent: 'center' }}>
      {p.plate ? (
        // The plate's padding sits outside the text box (negative margins), so text keeps the full text-area width.
        <div style={{ position: 'relative', padding: '20px 28px', margin: '0 -28px', borderRadius: 18 }}>
          <div style={{ position: 'absolute', inset: 0, background: p.plate, opacity: 0.94 * plateOpacity, borderRadius: 18 }} />
          <div style={{ position: 'relative' }}>{block}</div>
        </div>
      ) : (
        block
      )}
    </div>
  );
};
