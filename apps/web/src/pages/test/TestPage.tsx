import { useEffect, useRef, useState } from 'react';
import './TestPage.css';

export function TestPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [sizeLabel, setSizeLabel] = useState<string>('IFRAME');

  useEffect(() => {
    const stage = stageRef.current;
    const iframe = iframeRef.current;
    if (!stage || !iframe) return;

    const updateLabel = () => {
      const stageRect = stage.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      let guestH: number | string = '?';
      try {
        guestH = iframe.contentWindow?.innerHeight ?? '?';
      } catch {
        guestH = 'blocked';
      }
      setSizeLabel(
        `IFRAME | Host ${Math.round(stageRect.width)}x${Math.round(stageRect.height)} | Box ${Math.round(iframeRect.width)}x${Math.round(iframeRect.height)} | GuestH ${guestH}`,
      );
    };

    iframe.addEventListener('load', updateLabel);
    window.addEventListener('resize', updateLabel);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateLabel) : null;
    ro?.observe(stage);

    return () => {
      iframe.removeEventListener('load', updateLabel);
      window.removeEventListener('resize', updateLabel);
      ro?.disconnect();
    };
  }, []);

  return (
    <section className="test-page-wrap">
      <h3 className="test-page-title">Test</h3>
      <div className="test-page-webview-stage" ref={stageRef}>
        <div className="test-page-webview-label">{sizeLabel}</div>
        <iframe
          ref={iframeRef}
          src="https://example.com"
          className="test-page-webview"
          title="test-frame"
        />
      </div>
    </section>
  );
}
