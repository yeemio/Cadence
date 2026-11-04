import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '@/components/ui/button';
import { loadDrawingPdf, type ClearanceLevel } from './drawingApi';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function DrawingPdfReader({ drawingId, version, clearance }: {
  readonly drawingId: string;
  readonly version: number;
  readonly clearance: ClearanceLevel;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    const abort = new AbortController();
    void (async () => {
      try {
        const data = await loadDrawingPdf(drawingId, version, clearance, abort.signal);
        if (!active) return;
        task = getDocument({ data, useSystemFonts: true });
        const document = await task.promise;
        if (active) setPdf(document);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'PDF 加载失败');
      }
    })();
    return () => {
      active = false;
      abort.abort();
      void task?.destroy();
    };
  }, [drawingId, version, clearance]);

  useEffect(() => {
    if (pdf === null) return;
    let active = true;
    let task: RenderTask | undefined;
    setRendering(true);
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (!active || canvas === null) return;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('浏览器无法绘制 PDF');
        const viewport = page.getViewport({ scale: zoom / 100 });
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        task = page.render({ canvas, canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await task.promise;
        if (active) setRendering(false);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'PDF 绘制失败');
      }
    })();
    return () => { active = false; task?.cancel(); };
  }, [pdf, pageNumber, zoom]);

  return (
    <section aria-label="图纸 PDF 阅读器" className="mt-4 flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="PDF 翻页与缩放">
        <span className="mr-auto text-sm font-medium">{drawingId} · v{version}</span>
        <Button variant="outline" size="sm" disabled={pdf === null || rendering || pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}>PDF 上一页</Button>
        <span aria-live="polite" className="text-sm">第 {pageNumber} / {pdf?.numPages ?? '…'} 页</span>
        <Button variant="outline" size="sm" disabled={pdf === null || rendering || pageNumber >= pdf.numPages} onClick={() => setPageNumber(pageNumber + 1)}>PDF 下一页</Button>
        <Button variant="outline" size="sm" aria-label="缩小 PDF" disabled={pdf === null || rendering || zoom <= 50} onClick={() => setZoom(zoom - 25)}>−</Button>
        <span aria-live="polite" className="min-w-12 text-center text-sm">{zoom}%</span>
        <Button variant="outline" size="sm" aria-label="放大 PDF" disabled={pdf === null || rendering || zoom >= 200} onClick={() => setZoom(zoom + 25)}>+</Button>
      </div>
      {error !== null ? <p role="alert" className="text-sm text-destructive">PDF 打开失败：{error}</p> : (
        <>
          <p role="status" className="text-xs text-muted-foreground">{rendering ? '正在加载 PDF…' : `第 ${pageNumber} 页已显示`}</p>
          <div className="max-h-[75vh] overflow-auto rounded bg-muted/40 p-3">
            <canvas ref={canvasRef} role="img" aria-label={`${drawingId} v${version} PDF 第 ${pageNumber} 页`} className="mx-auto bg-white" />
          </div>
        </>
      )}
    </section>
  );
}
