// IPC договоров: список, конструктор, приложения, выгрузка в Word/PDF.
import type { HandleFn } from './ipcReports.ts';
import { contractHtmlToPdf } from './payouts/pdfRender.ts';
import { FIELDS } from './contracts/fields.ts';
import { headerLogoBase64 } from './contracts/engine.ts';
import { deleteAppendix, deleteContract, draftAppendix, exportContractFile, getContract, listContracts, listPeopleWithoutContract, newContract, previewContract, saveAppendix, saveContract, trackRow } from './contracts/service.ts';
import { requireSession } from './session.ts';

export function registerContractsIpc(handle: HandleFn): void {
  handle('contracts:list', () => listContracts(requireSession().db));
  handle('contracts:missing', () => listPeopleWithoutContract(requireSession().db));
  handle('contracts:fields', () => FIELDS);
  handle('contracts:new', ({ counterpartyId }) => newContract(requireSession().db, counterpartyId));
  handle('contracts:get', ({ id }) => getContract(requireSession().db, id));
  handle('contracts:preview', (e) => previewContract(requireSession().db, e));
  handle('contracts:save', (e) => { const s = requireSession(); return saveContract(s.db, s.ctx, e); });
  handle('contracts:delete', ({ id }) => { const s = requireSession(); deleteContract(s.db, s.ctx, id); });
  handle('contracts:export', async ({ req, edit, draft }) => {
    const s = requireSession();
    const path = await exportContractFile(s.db, s.paths.output, req, edit, draft, (html) => contractHtmlToPdf(html, headerLogoBase64()));
    return { path };
  });
  handle('appendix:draft', ({ contractId, appendixId }) => draftAppendix(requireSession().db, contractId, appendixId ?? null));
  handle('appendix:track', ({ contractId, trackId, date }) => trackRow(requireSession().db, contractId, trackId, date));
  handle('appendix:save', ({ contractId, draft }) => { const s = requireSession(); return saveAppendix(s.db, s.ctx, contractId, draft); });
  handle('appendix:delete', ({ id }) => { const s = requireSession(); deleteAppendix(s.db, s.ctx, id); });
}
