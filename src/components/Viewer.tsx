import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize, 
  ChevronLeft, 
  ChevronRight, 
  MousePointer2, 
  CircleDot,
  Ruler,
  Square,
  Hash,
  FolderOpen,
  Check,
  Scaling
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ToolType, Point, TakeoffRow, MeasurementType, Drawing } from '../types';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface ViewerProps {
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  measurements: TakeoffRow[];
  onAddMeasurement: (m: Omit<TakeoffRow, 'id' | 'color' | 'isVisible' | 'drawingId'>) => void;
  scaleFactor: number;
  onScaleSet: (factor: number) => void;
  activeDrawing: Drawing | null;
  onDrawingAdded: (name: string, fileUrl: string, file?: File) => void;
}

export function Viewer({ 
  activeTool, 
  setActiveTool, 
  measurements, 
  onAddMeasurement,
  scaleFactor,
  onScaleSet,
  activeDrawing,
  onDrawingAdded
}: ViewerProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.5);
  const [loading, setLoading] = useState(false);
  const [tempPoints, setTempPoints] = useState<Point[]>([]);
  const [cursorPoint, setCursorPoint] = useState<Point | null>(null);
  const [pdfDimensions, setPdfDimensions] = useState<{w: number, h: number} | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // Clear temp points when tool changes
  useEffect(() => {
    setTempPoints([]);
    setCursorPoint(null);
  }, [activeTool]);

  const fitToScreen = useCallback(async (pdfDoc: pdfjsLib.PDFDocumentProxy, pageNum: number) => {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        const padding = 64; 
        const scaleX = (width - padding) / viewport.width;
        const scaleY = (height - padding) / viewport.height;
        const fitScale = Math.min(scaleX, scaleY);
        setScale(Math.max(0.1, fitScale));
      }
    } catch (err) {
      console.error('Fit to screen error', err);
    }
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file: File) => {
      const url = URL.createObjectURL(file);
      onDrawingAdded(file.name, url, file);
    });
  };

  useEffect(() => {
    let isMounted = true;
    if (!activeDrawing?.fileUrl) {
      setPdf(null);
      return;
    }
    
    setLoading(true);

    const handlePdfLoad = (pdfDoc: pdfjsLib.PDFDocumentProxy) => {
      if (!isMounted) return;
      setPdf(pdfDoc);
      setPageNumber(1);
      fitToScreen(pdfDoc, 1);
      setLoading(false);
    };

    const handlePdfError = (err: any) => {
      console.error(err);
      if (isMounted) setLoading(false);
    };

    if (activeDrawing.file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (!isMounted) return;
        const arrayBuffer = reader.result as ArrayBuffer;
        pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise
          .then(handlePdfLoad)
          .catch(handlePdfError);
      };
      reader.onerror = handlePdfError;
      reader.readAsArrayBuffer(activeDrawing.file);
    } else {
      pdfjsLib.getDocument(activeDrawing.fileUrl).promise
        .then(handlePdfLoad)
        .catch(handlePdfError);
    }

    return () => { isMounted = false; };
  }, [activeDrawing, fitToScreen]);

  // PDF rendering effect
  useEffect(() => {
    if (!pdf) return;

    let active = true;
    let renderTask: any = null;

    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;
        
        const viewport = page.getViewport({ scale });
        const canvas = pdfCanvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        // Ensure canvas dimensions match viewport
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        if (drawingCanvasRef.current) {
          drawingCanvasRef.current.width = viewport.width;
          drawingCanvasRef.current.height = viewport.height;
        }

        setPdfDimensions({ w: viewport.width, h: viewport.height });

        const renderContext = {
          canvasContext: context,
          viewport,
        };

        renderTask = page.render(renderContext);
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Render error:', err);
        }
      }
    };

    renderPage();

    return () => {
      active = false;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdf, pageNumber, scale]);

  // Drawing effect
  useEffect(() => {
    const canvas = drawingCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    measurements.forEach(m => {
      if (!m.isVisible) return;
      if (m.points.length === 0) return;
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color + '60'; // More visible fill
      ctx.lineWidth = 3; // Thicker lines

      ctx.beginPath();
      ctx.moveTo(m.points[0].x, m.points[0].y);
      m.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      
      if (m.type === 'Area') ctx.closePath();
      ctx.stroke();
      if (m.type === 'Area') ctx.fill();

      m.points.forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); // Larger points
        ctx.fill();
        ctx.stroke();
        if (m.type === 'Count') {
          ctx.fillStyle = 'white';
          ctx.font = '12px monospace'; // Larger font
          ctx.fillText((idx+1).toString(), p.x + 8, p.y - 8);
          ctx.fillStyle = m.color + '60';
        }
      });
    });

    if (tempPoints.length > 0 || (cursorPoint && activeTool !== 'select')) {
      ctx.strokeStyle = '#F59E0B';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      let allPoints = [...tempPoints];
      if (cursorPoint && tempPoints.length > 0) {
        allPoints.push(cursorPoint);
      }
      
      if (allPoints.length > 0) {
        ctx.moveTo(allPoints[0].x, allPoints[0].y);
        allPoints.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        
        if (activeTool === 'area' && allPoints.length > 2) {
           ctx.lineTo(allPoints[0].x, allPoints[0].y);
           ctx.fillStyle = '#F59E0B40';
           ctx.fill();
        }
  
        ctx.stroke();
        ctx.setLineDash([]);
        
        allPoints.forEach(p => {
          ctx.beginPath();
          ctx.fillStyle = '#F59E0B';
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
  
        // Show real-time measurement value
        if (allPoints.length > 1) {
          let text = '';
          if (activeTool === 'area' && allPoints.length > 2) {
            let area = 0;
            for (let i = 0; i < allPoints.length; i++) {
              const j = (i + 1) % allPoints.length;
              area += allPoints[i].x * allPoints[j].y;
              area -= allPoints[j].x * allPoints[i].y;
            }
            area = Math.abs(area) / 2;
            const qty = area * (scaleFactor * scaleFactor); 
            text = `${qty.toFixed(2)} sq ${activeDrawing ? 'u' : 'm'}`;
          } else if (activeTool === 'linear' || activeTool === 'scale') {
            let length = 0;
            for(let i=1; i<allPoints.length; i++) {
              const dx = allPoints[i].x - allPoints[i-1].x;
              const dy = allPoints[i].y - allPoints[i-1].y;
              length += Math.sqrt(dx*dx + dy*dy);
            }
            if (activeTool === 'scale') {
              text = `${length.toFixed(2)} px`;
            } else {
              const qty = length * scaleFactor;
              text = `${qty.toFixed(2)} u`;
            }
          }
          
          if (text && cursorPoint) {
            ctx.fillStyle = '#F59E0B';
            ctx.font = 'bold 12px monospace';
            const textWidth = ctx.measureText(text).width;
            ctx.fillRect(cursorPoint.x + 10, cursorPoint.y - 20, textWidth + 8, 20);
            ctx.fillStyle = 'black';
            ctx.fillText(text, cursorPoint.x + 14, cursorPoint.y - 6);
          }
        }
      }
    }
  }, [measurements, tempPoints, cursorPoint, pdfDimensions, activeTool, scaleFactor, activeDrawing]);

  const handleManualScale = () => {
    const ratioStr = window.prompt("Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):");
    if (!ratioStr) return;
    
    if (ratioStr.includes(':')) {
      const parts = ratioStr.split(':');
      if (parts.length === 2) {
        const paper = parseFloat(parts[0]);
        const real = parseFloat(parts[1]);
        if (!isNaN(paper) && !isNaN(real) && real > 0) {
          // If the user imports a standard DPI drawing, giving a ratio assumes 1 "paper unit" = "some pixels"
          // Let's assume paper unit is mm, so at 72dpi, 1mm = 2.83 pixels
          // For now, let's just make it simple: 
          alert("Ratio parsing: assuming standard unit. Please use 'Draw Calibration' for accurate pixel-to-real mapping if dimensions are off.");
          onScaleSet(real / paper);
        }
      }
    } else {
      const factor = parseFloat(ratioStr);
      if (!isNaN(factor) && factor > 0) {
        onScaleSet(factor);
      }
    }
  };

  const finishMeasurement = useCallback(() => {
    if (tempPoints.length < 2) {
      setTempPoints([]);
      setCursorPoint(null);
      return;
    }

    if (activeTool === 'scale') {
      const dx = tempPoints[1].x - tempPoints[0].x;
      const dy = tempPoints[1].y - tempPoints[0].y;
      const pixelLength = Math.sqrt(dx*dx + dy*dy);
      
      const realStr = window.prompt("Enter real world length in meters (e.g. 5):", "5");
      if (realStr) {
        const realLen = parseFloat(realStr);
        if (!isNaN(realLen) && realLen > 0) {
          onScaleSet(realLen / pixelLength);
        }
      }
      setTempPoints([]);
      setCursorPoint(null);
      setActiveTool('select');
      return;
    }

    let type: MeasurementType = 'Length';
    let qty = 0;
    let unit = 'm';

    if (activeTool === 'area') {
      type = 'Area';
      let area = 0;
      for (let i = 0; i < tempPoints.length; i++) {
        const j = (i + 1) % tempPoints.length;
        area += tempPoints[i].x * tempPoints[j].y;
        area -= tempPoints[j].x * tempPoints[i].y;
      }
      area = Math.abs(area) / 2;
      qty = area * (scaleFactor * scaleFactor); 
      unit = 'sq m';
    } else if (activeTool === 'linear') {
      type = 'Length';
      let length = 0;
      for(let i=1; i<tempPoints.length; i++) {
        const dx = tempPoints[i].x - tempPoints[i-1].x;
        const dy = tempPoints[i].y - tempPoints[i-1].y;
        length += Math.sqrt(dx*dx + dy*dy);
      }
      qty = length * scaleFactor;
      unit = 'm';
    }

    onAddMeasurement({
      description: `New ${type}`,
      type,
      quantity: qty,
      unit,
      unitRate: 0,
      notes: '',
      points: tempPoints,
      isOverridden: false,
    });
    setTempPoints([]);
    setCursorPoint(null);
  }, [tempPoints, activeTool, scaleFactor, onAddMeasurement, onScaleSet, setActiveTool]);

  useEffect(() => {
    if (activeTool === 'scale' && tempPoints.length === 2) {
      finishMeasurement();
    }
  }, [tempPoints, activeTool, finishMeasurement]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') return;

    if (e.button === 2) {
      finishMeasurement();
      return;
    }

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const pointX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const pointY = (e.clientY - rect.top) * (drawingCanvasRef.current!.height / rect.height);

    const currentPoint = { x: pointX, y: pointY };

    if (activeTool === 'count') {
      onAddMeasurement({
        description: 'New Count',
        type: 'Count',
        quantity: measurements.filter(m => m.type === 'Count').length + 1,
        unit: 'EA',
        unitRate: 0,
        notes: '',
        points: [currentPoint],
        isOverridden: false,
      });
      return;
    }

    if (activeTool === 'point') {
      onAddMeasurement({
        description: 'Point Marker',
        type: 'Point',
        quantity: 1,
        unit: 'PT',
        unitRate: 0,
        notes: '',
        points: [currentPoint],
        isOverridden: false,
      });
      return;
    }

    setTempPoints(prev => [...prev, currentPoint]);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activeTool !== 'select') {
      finishMeasurement();
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select' || activeTool === 'point' || activeTool === 'count') return;
    if (tempPoints.length === 0) return; // Wait, actually it's nice to see dot even if no points

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const pointX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const pointY = (e.clientY - rect.top) * (drawingCanvasRef.current!.height / rect.height);
    
    setCursorPoint({ x: pointX, y: pointY });
  };

  // Zooming via Wheel
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        
        setScale(s => {
          const newScale = Math.max(0.1, s + delta);
          if (newScale !== s) {
            const ratio = newScale / s;
            const canvasRect = drawingCanvasRef.current?.getBoundingClientRect();
            if (canvasRect) {
               const mouseCanvasX = e.clientX - canvasRect.left;
               const mouseCanvasY = e.clientY - canvasRect.top;
               
               const scrollDeltaX = (mouseCanvasX * ratio) - mouseCanvasX;
               const scrollDeltaY = (mouseCanvasY * ratio) - mouseCanvasY;

               setTimeout(() => {
                 if (containerRef.current) {
                   containerRef.current.scrollLeft += scrollDeltaX;
                   containerRef.current.scrollTop += scrollDeltaY;
                 }
               }, 0);
            }
          }
          return newScale;
        });
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Panning Support
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && activeTool === 'select')) {
      e.preventDefault();
      setIsPanning(true);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'grabbing';
      }
    }
  };

  const handlePointerUp = () => {
    setIsPanning(false);
    if (containerRef.current) {
      containerRef.current.style.cursor = '';
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPanning && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop -= e.movementY;
    }
  };

  const tools = [
    { id: 'select', icon: MousePointer2, label: 'Select (Pan)', shortcut: 'V' },
    { id: 'point', icon: CircleDot, label: 'Point', shortcut: 'P' },
    { id: 'linear', icon: Ruler, label: 'Linear', shortcut: 'L' },
    { id: 'area', icon: Square, label: 'Area', shortcut: 'A' },
    { id: 'count', icon: Hash, label: 'Count', shortcut: 'C' },
    { id: 'scale', icon: Scaling, label: 'Calibrate', shortcut: 'S' },
  ];

  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden">
      {/* Canvas Header/Tools */}
      <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-20 shadow-sm relative">
        <div className="flex gap-1">
          {tools.map(tool => (
            <button
              key={tool.id}
              onClick={() => setActiveTool(tool.id as ToolType)}
              className={cn(
                "w-9 h-9 flex items-center justify-center transition-all relative group border",
                activeTool === tool.id 
                  ? "bg-zinc-800 border-amber-accent text-amber-accent" 
                  : "bg-transparent border-transparent text-zinc-500 hover:text-zinc-200"
              )}
              title={`${tool.label} (${tool.shortcut})`}
            >
              <tool.icon className="w-4 h-4" />
              <span className="sr-only">{tool.label}</span>
              <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
                {tool.label} [{tool.shortcut}]
              </div>
            </button>
          ))}
        </div>

        <div className="flex flex-col md:flex-row items-center gap-3">
          <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
            <span className="text-[10px] font-mono font-bold text-amber-accent tracking-tighter whitespace-nowrap">
              {scaleFactor === 1 ? 'NOT CALIBRATED' : `1px = ${scaleFactor.toFixed(4)}u`}
            </span>
          </div>
          <button 
            onClick={() => setActiveTool('scale')}
            className={cn(
               "text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border",
               activeTool === 'scale' ? "bg-amber-accent text-black border-amber-accent" : "text-amber-accent border-amber-accent hover:bg-amber-accent hover:text-black"
            )}
            title="Draw a line to calibrate scale"
          >
            DRAW CALIBRATION
          </button>
          <button 
            onClick={handleManualScale}
            className="text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border text-amber-accent border-amber-accent hover:bg-amber-accent hover:text-black"
            title="Set scale factor manually"
          >
            MANUAL SCALE
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setScale(s => Math.max(0.1, s - 0.1))} className="p-1.5 text-zinc-500 hover:text-zinc-200"><ZoomOut className="w-4 h-4" /></button>
          <span className="text-[10px] font-mono text-zinc-400 w-12 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(s => s + 0.1)} className="p-1.5 text-zinc-500 hover:text-zinc-200"><ZoomIn className="w-4 h-4" /></button>
          <div className="w-px h-4 bg-industrial-border mx-1" />
          <button onClick={() => {
            if (pdf) fitToScreen(pdf, pageNumber);
          }} className="p-1.5 text-zinc-500 hover:text-zinc-200"><Maximize className="w-4 h-4" title="Fit to Screen" /></button>
        </div>
      </div>

      {/* Main View Area */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (tempPoints.length > 0) {
              finishMeasurement();
            } else {
              setActiveTool('select');
            }
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        tabIndex={0}
      >
        <div className={cn("min-h-full min-w-full flex w-max h-max", !pdf ? "items-center justify-center p-8" : "p-[50vh] xl:p-[100vh]")}>
          {!pdf && !loading && (
            <div className="flex flex-col items-center gap-6 p-12 border-2 border-dashed border-industrial-border bg-industrial-panel/50 backdrop-blur-sm max-w-xl w-full text-center">
              <FolderOpen className="w-12 h-12 text-zinc-700" />
              <div>
                <h2 className="text-xl font-mono font-bold tracking-tighter text-zinc-200 mb-2">IMPORT PROJECT DRAWING</h2>
                <p className="text-xs text-zinc-500 font-mono leading-relaxed uppercase tracking-widest">
                  DRAG AND DROP OR SELECT A PDF, DWG, OR IMAGE FILE TO BEGIN MEASURING QUANTITIES.
                </p>
              </div>
              <label className="bg-amber-accent hover:bg-amber-400 text-black px-10 py-3 font-mono font-bold text-xs uppercase tracking-widest cursor-pointer transition-all shadow-xl shadow-amber-accent/10 active:scale-95">
                Select File(s)
                <input type="file" multiple className="hidden" accept=".pdf,.png,.jpg,.jpeg,.dwg" onChange={handleFileUpload} />
              </label>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center gap-4 m-auto">
              <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-accent rounded-full animate-spin" />
              <span className="text-[10px] font-mono font-bold text-amber-accent tracking-[0.2em] uppercase animate-pulse">Processing Vector Data...</span>
            </div>
          )}

          {pdf && (
            <div 
              className="relative shadow-2xl border border-industrial-border bg-white transition-all flex-shrink-0 m-auto"
              style={pdfDimensions ? { width: pdfDimensions.w, height: pdfDimensions.h } : {}}
            >
              <canvas 
                ref={pdfCanvasRef} 
                className="absolute inset-0 z-0 pointer-events-none"
              />
              <canvas 
                ref={drawingCanvasRef}
                onClick={handleCanvasClick}
                onContextMenu={handleContextMenu}
                onPointerMove={handleCanvasPointerMove}
                onPointerLeave={() => setCursorPoint(null)}
                className={cn(
                  "absolute inset-0 z-10 w-full h-full mix-blend-multiply",
                  activeTool !== 'select' && !isPanning ? "cursor-crosshair" : 
                  isPanning ? "cursor-grabbing" : "cursor-grab"
                )}
              />
              {tempPoints.length > 1 && (activeTool === 'area' || activeTool === 'linear') && (
                <button
                  className="absolute z-20 flex items-center justify-center gap-1.5 bg-amber-accent text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-400 active:scale-95 transition-transform"
                  style={{ 
                    left: tempPoints[tempPoints.length - 1].x + 15, 
                    top: tempPoints[tempPoints.length - 1].y + 15 
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    finishMeasurement();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Check className="w-3 h-3" />
                  Finish
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Canvas Footer */}
      {pdf && (
        <div className="h-10 flex-shrink-0 bg-industrial-panel border-t border-industrial-border px-4 flex items-center justify-between z-20 font-mono relative shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setPageNumber(p => Math.max(1, p - 1))}
                className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                disabled={pageNumber <= 1}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
                PAGE {pageNumber} OF {pdf.numPages}
              </span>
              <button 
                onClick={() => setPageNumber(p => Math.min(pdf.numPages, p + 1))}
                className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                disabled={pageNumber >= pdf.numPages}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest hidden md:flex">
            <span>Press ESC or Right-click to finish drawing</span>
            <div className="w-px h-3 bg-industrial-border" />
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
          </div>
        </div>
      )}
    </div>
  );
}
