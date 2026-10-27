import { useEffect, useState } from 'react';
import type { Dashboard } from '../../../shared/api.ts';
import { call, issueLabel } from '../api.ts';
import { StarterDialog } from './StarterDialog.tsx';

export function Home({ tick, onChanged, goto }: { tick: number; onChanged: () => void; goto: (t: string) => void }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [starter, setStarter] = useState(false);
  useEffect(() => { void call('dash:get').then(setD); }, [tick]);
  if (!d) return null;
  const empty = d.tracks === 0 && d.people === 0;
  const cards: Array<[string, number, string]> = [
    ['Люди', d.people, 'people'], ['Артисты', d.artists, 'artists'], ['Треки', d.tracks, 'tracks'],
    ['Участия в треках', d.participations, 'tracks'], ['Договоры', d.contracts, 'people'], ['Артисты без человека', d.artistsWithoutPerson, 'artists'],
  ];
  return (
    <>
      <h1>Главная</h1>
      {empty && (
        <div className="card" style={{ marginBottom: 18 }}>
          <b>База пуста.</b> Загрузите стартовую базу (Стартовая_база.xlsx), чтобы заполнить людей, артистов, треки и доли.
          <div className="row end"><button className="primary" onClick={() => setStarter(true)}>Загрузить стартовую базу</button></div>
        </div>
      )}
      <div className="cards">
        {cards.map(([l, n, t]) => (
          <div key={l} className="card" style={{ cursor: 'pointer' }} onClick={() => goto(t)}><div className="n">{n}</div><div className="l">{l}</div></div>
        ))}
      </div>
      <h2>Открытые проблемы</h2>
      {Object.keys(d.openIssues).length === 0 ? <div className="dim">Всё чисто.</div> : (
        <div>{Object.entries(d.openIssues).map(([k, n]) => <span key={k} className="badge bad" style={{ cursor: 'pointer' }} onClick={() => goto('issues')}>{issueLabel(k)}: {n}</span>)}</div>
      )}
      {starter && <StarterDialog onClose={() => { setStarter(false); onChanged(); }} />}
    </>
  );
}
