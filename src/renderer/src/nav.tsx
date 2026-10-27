import { createContext, useContext } from 'react';

export type Tab = 'home' | 'tracks' | 'people' | 'artists' | 'reports' | 'lines' | 'payouts' | 'contracts' | 'issues' | 'tax' | 'settings';
/** Куда прыгнуть и что там открыть: одна механика для всех красных пометок. */
export interface NavParams {
  personId?: string;
  trackId?: string;
  query?: string;
  contractFor?: string;
  contractId?: string;
  reportVersionId?: string;
  issueKind?: string;
}
export interface NavApi { go: (tab: Tab, params?: NavParams) => void; params: NavParams; clear: () => void }

export const NavContext = createContext<NavApi>({ go: () => {}, params: {}, clear: () => {} });
export const useNav = (): NavApi => useContext(NavContext);
