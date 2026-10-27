// Печать HTML в PDF средствами Electron (скрытое окно, printToPDF). Только для main-процесса приложения.
import { BrowserWindow } from 'electron';

export async function htmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    return await win.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } });
  } finally {
    win.destroy();
  }
}
