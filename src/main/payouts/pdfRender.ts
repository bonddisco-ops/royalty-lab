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

/** Договор/приложение: размеры страниц берутся из CSS (@page), сверху — логотип, снизу — номер страницы. */
export async function contractHtmlToPdf(html: string, logoPngBase64: string | null): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const header = logoPngBase64
      ? `<div style="width:100%;text-align:center;margin-top:6px"><img src="data:image/png;base64,${logoPngBase64}" style="height:38px"/></div>`
      : '<span></span>';
    const footer = '<div style="width:100%;text-align:center;font-size:9px;font-family:serif"><span class="pageNumber"></span></div>';
    return await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: header, footerTemplate: footer });
  } finally {
    win.destroy();
  }
}
