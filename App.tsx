import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionState, LogEntry, Scenario } from './types';
import { MODEL_NAME, SCENARIOS } from './constants';
import { createPcmBlob, decodeAudioData, base64ToArrayBuffer, blobToBase64 } from './utils/audioStreamer';
import AudioVisualizer from './components/AudioVisualizer';
import ScenarioSelector from './components/ScenarioSelector';

// Icons
const CameraIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>;
const MicIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>;
const StopIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6"/></svg>;
const PlayIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>;
const AlertTriangle = () => <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;

const App: React.FC = () => {
  // State
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [currentScenario, setCurrentScenario] = useState<Scenario>(SCENARIOS[0]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inputVolume, setInputVolume] = useState(0);
  const [outputVolume, setOutputVolume] = useState(0);
  const [latestTranscript, setLatestTranscript] = useState<string>('');
  const [safetyAlert, setSafetyAlert] = useState<boolean>(false);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  
  // Logic Refs
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const sessionRef = useRef<any>(null); // To store the active session

  // ---------------------------------------------------------------------------
  // Logging Helper
  // ---------------------------------------------------------------------------
  const addLog = (sender: LogEntry['sender'], message: string, type: LogEntry['type'] = 'text') => {
    setLogs(prev => [...prev, { timestamp: new Date(), sender, message, type }]);
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // ---------------------------------------------------------------------------
  // Gemini Live Connection Logic
  // ---------------------------------------------------------------------------
  const startSession = async () => {
    if (!process.env.API_KEY) {
      alert("API Key not found in environment variables.");
      return;
    }

    try {
      setConnectionState(ConnectionState.CONNECTING);
      addLog('system', `Initializing Kinetic (${currentScenario.name})...`);

      // 1. Setup Audio Contexts
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // 2. Get Media Stream (Video + Audio)
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }, 
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 },
          facingMode: 'environment' // Prefer back camera on mobile
        } 
      });
      audioStreamRef.current = stream;

      // 3. Connect Video Element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      // 4. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // 5. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setConnectionState(ConnectionState.CONNECTED);
            addLog('system', 'Connected to Gemini Live Network.');
            addLog('ai', "I'm online. Show me what you're working on.", 'audio');
            
            // Start Audio Streaming
            if (!inputAudioContextRef.current || !stream) return;
            
            const source = inputAudioContextRef.current.createMediaStreamSource(stream);
            // Analyze volume for visualizer
            const analyser = inputAudioContextRef.current.createAnalyser();
            analyser.fftSize = 64;
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            
            // Processor for sending chunks
            const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Visualizer logic
              analyser.getByteFrequencyData(dataArray);
              let sum = 0;
              for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
              setInputVolume(sum / dataArray.length / 255);

              // Send to API
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(analyser);
            analyser.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current.destination);
          },

          onmessage: async (message: LiveServerMessage) => {
             // Handle Text Transcription (for HUD)
             if (message.serverContent?.modelTurn?.parts) {
               const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
               if (textPart && textPart.text) {
                 setLatestTranscript(textPart.text);
                 // Simple keyword detection for safety alert
                 if (textPart.text.toUpperCase().includes("STOP")) {
                    setSafetyAlert(true);
                    setTimeout(() => setSafetyAlert(false), 3000);
                 }
               }
             }

             if (message.serverContent?.outputTranscription?.text) {
                 const text = message.serverContent.outputTranscription.text;
                 setLatestTranscript(prev => {
                     // Keep only last 100 chars to avoid huge strings
                     const newText = prev + text;
                     return newText.slice(-150);
                 });
                 if (text.toUpperCase().includes("STOP")) {
                    setSafetyAlert(true);
                    setTimeout(() => setSafetyAlert(false), 3000);
                 }
             }

             // Handle Audio Output
             const base64Audio = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
             if (base64Audio && outputAudioContextRef.current) {
                const ctx = outputAudioContextRef.current;
                
                // Decode
                const audioBuffer = await decodeAudioData(
                  new Uint8Array(base64ToArrayBuffer(base64Audio)),
                  ctx,
                  24000 // Gemini Flash Native Audio rate
                );

                // Scheduling
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                
                // Visualizer for output
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 64;
                source.connect(analyser);
                analyser.connect(ctx.destination);
                
                // Animate output volume
                const updateVol = () => {
                    const data = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteFrequencyData(data);
                    let sum = 0;
                    for(let i=0; i<data.length; i++) sum += data[i];
                    setOutputVolume(sum / data.length / 255);
                    if(sourcesRef.current.has(source)) requestAnimationFrame(updateVol);
                    else setOutputVolume(0);
                };
                requestAnimationFrame(updateVol);

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                
                sourcesRef.current.add(source);
                source.onended = () => {
                    sourcesRef.current.delete(source);
                };
             }

             // Handle Interruption
             if (message.serverContent?.interrupted) {
                 addLog('system', 'Interrupted');
                 sourcesRef.current.forEach(source => source.stop());
                 sourcesRef.current.clear();
                 nextStartTimeRef.current = 0;
             }
          },

          onclose: () => {
            addLog('system', 'Session closed');
            setConnectionState(ConnectionState.DISCONNECTED);
          },
          
          onerror: (err) => {
            console.error(err);
            addLog('system', 'Error: ' + JSON.stringify(err), 'alert');
            setConnectionState(ConnectionState.ERROR);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: currentScenario.systemInstruction,
          outputAudioTranscription: {}, // Enable subtitles
        }
      });

      // Save session logic wrapper
      sessionRef.current = sessionPromise;

      // 6. Start Video Frame Loop
      const intervalId = window.setInterval(async () => {
        if (!canvasRef.current || !videoRef.current) return;
        
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        // Draw video to canvas (resized to reduce bandwidth)
        const width = 640;
        const height = 480; // sufficient for model vision
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        ctx.drawImage(videoRef.current, 0, 0, width, height);

        // Convert to Blob -> Base64
        canvasRef.current.toBlob(async (blob) => {
           if (blob) {
             const base64Data = await blobToBase64(blob);
             sessionPromise.then(session => {
               session.sendRealtimeInput({
                 media: { 
                   mimeType: 'image/jpeg', 
                   data: base64Data 
                 }
               });
             });
           }
        }, 'image/jpeg', 0.6); // 60% quality JPEG

      }, 1000); // 1 FPS is usually sufficient for "observing" tasks, increase to 2-5 if needed for fast motion. 
      // NOTE: PRD says "real-time". 1 FPS is slow for "STOP". Let's do 500ms (2 FPS).
      // Higher FPS = more token usage.
      
      frameIntervalRef.current = window.setInterval(() => {
          // Re-implementing inside logic to ensure correct timing
      }, 1000) as unknown as number; 
      
      // Clearing the previous Interval logic and using the one inside the loop above
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = window.setInterval(async () => {
         if (!canvasRef.current || !videoRef.current) return;
         const ctx = canvasRef.current.getContext('2d');
         if (!ctx) return;
         
         canvasRef.current.width = 640;
         canvasRef.current.height = 360; // 16:9 low res
         ctx.drawImage(videoRef.current, 0, 0, 640, 360);
         
         canvasRef.current.toBlob(async (blob) => {
           if(blob) {
             const base64 = await blobToBase64(blob);
             sessionPromise.then(s => s.sendRealtimeInput({
                 media: { mimeType: 'image/jpeg', data: base64 }
             }));
           }
         }, 'image/jpeg', 0.5);
      }, 500); // 2 FPS

    } catch (e) {
      console.error(e);
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const stopSession = () => {
    // 1. Close Live Session
    if (sessionRef.current) {
        sessionRef.current.then((s: any) => s.close());
    }
    
    // 2. Stop Tracks
    if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(t => t.stop());
    }

    // 3. Clear Intervals
    if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
    }

    // 4. Close Audio Contexts
    inputAudioContextRef.current?.close();
    outputAudioContextRef.current?.close();

    setConnectionState(ConnectionState.DISCONNECTED);
    setLogs([]);
    setLatestTranscript('');
    setInputVolume(0);
    setOutputVolume(0);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-screen bg-slate-900 text-white overflow-hidden">
      
      {/* HEADER */}
      <header className="flex items-center justify-between px-6 py-4 bg-slate-950 border-b border-slate-800 z-10">
        <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center font-bold font-mono text-lg">
                K
            </div>
            <div>
                <h1 className="font-bold text-lg tracking-tight">Kinetic</h1>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className={`w-2 h-2 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></span>
                    {connectionState} {connectionState === ConnectionState.CONNECTED && `• ${currentScenario.name}`}
                </div>
            </div>
        </div>
      </header>

      {/* MAIN CONTENT GRID */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        
        {/* LEFT: VISION CENTER */}
        <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
             
            {/* ALERT OVERLAY */}
            {safetyAlert && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-red-500/30 backdrop-blur-sm animate-pulse border-[10px] border-red-500">
                    <div className="bg-red-600 text-white px-10 py-6 rounded-xl shadow-2xl flex flex-col items-center">
                        <AlertTriangle />
                        <h2 className="text-4xl font-black uppercase tracking-widest mt-4">STOP</h2>
                        <p className="text-xl font-mono mt-2">SAFETY HAZARD DETECTED</p>
                    </div>
                </div>
            )}

            {/* VIDEO FEED */}
            <video 
                ref={videoRef} 
                className="w-full h-full object-cover opacity-90" 
                muted 
                playsInline
            />
            {/* HIDDEN CANVAS FOR PROCESSING */}
            <canvas ref={canvasRef} className="hidden" />

            {/* HUD OVERLAY */}
            {connectionState === ConnectionState.CONNECTED && (
                <div className="absolute bottom-6 left-6 right-6 flex flex-col gap-2">
                    {/* Live Transcript Bubble */}
                    {latestTranscript && (
                        <div className="self-center bg-black/60 backdrop-blur text-white px-6 py-3 rounded-2xl border border-white/10 max-w-2xl text-center shadow-lg transition-all">
                             <p className="font-medium text-lg leading-relaxed">{latestTranscript}</p>
                        </div>
                    )}
                    
                    {/* Audio Vis */}
                    <div className="flex items-end justify-between mt-4">
                        <div className="bg-slate-900/80 backdrop-blur border border-slate-700 rounded-lg p-3 flex gap-4 items-center">
                            <div className="text-xs text-slate-400 font-mono">MIC INPUT</div>
                            <div className="w-32 h-8">
                                <AudioVisualizer isActive={true} volume={inputVolume} color="#3b82f6" />
                            </div>
                        </div>
                        <div className="bg-slate-900/80 backdrop-blur border border-slate-700 rounded-lg p-3 flex gap-4 items-center">
                            <div className="w-32 h-8">
                                <AudioVisualizer isActive={true} volume={outputVolume} color="#10b981" />
                            </div>
                             <div className="text-xs text-slate-400 font-mono">AI VOICE</div>
                        </div>
                    </div>
                </div>
            )}

            {/* START SCREEN OVERLAY */}
            {connectionState === ConnectionState.DISCONNECTED && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 z-20">
                    <div className="w-full max-w-md p-6">
                        <h2 className="text-2xl font-bold mb-6 text-center">Ready to work?</h2>
                        <ScenarioSelector 
                            selectedId={currentScenario.id} 
                            onSelect={setCurrentScenario} 
                            disabled={false} 
                        />
                        <button 
                            onClick={startSession}
                            className="w-full mt-8 bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-6 rounded-xl flex items-center justify-center gap-3 transition-all hover:scale-[1.02] shadow-xl shadow-blue-900/20"
                        >
                            <PlayIcon />
                            <span>Initialize Guardian Mode</span>
                        </button>
                        <p className="text-center text-slate-500 text-sm mt-4">
                            Requires Camera & Microphone permissions.
                        </p>
                    </div>
                </div>
            )}
        </div>

        {/* RIGHT: DEBUG/LOGS DRAWER (Visible on Desktop, collapsible or below on mobile) */}
        <div className="w-full md:w-80 bg-slate-950 border-l border-slate-800 flex flex-col h-1/3 md:h-full">
            <div className="p-4 border-b border-slate-800 font-mono text-xs uppercase text-slate-500 font-bold flex justify-between items-center">
                <span>System Logs</span>
                <span className="text-emerald-500">v0.9.1-beta</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-xs">
                {logs.length === 0 && <div className="text-slate-600 italic">System ready. Waiting for input...</div>}
                {logs.map((log, i) => (
                    <div key={i} className={`flex gap-2 ${log.type === 'alert' ? 'text-red-400' : 'text-slate-300'}`}>
                        <span className="text-slate-600 shrink-0">[{log.timestamp.toLocaleTimeString([], {hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit'})}]</span>
                        <span className={`${
                            log.sender === 'ai' ? 'text-emerald-400' : 
                            log.sender === 'user' ? 'text-blue-400' : 'text-slate-500'
                        } font-bold uppercase w-10 shrink-0`}>{log.sender}:</span>
                        <span className="break-words">{log.message}</span>
                    </div>
                ))}
                <div ref={logsEndRef} />
            </div>
            
            {/* CONTROLS */}
            <div className="p-4 border-t border-slate-800 bg-slate-900">
                {connectionState === ConnectionState.CONNECTED ? (
                    <button 
                        onClick={stopSession}
                        className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/50 py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-colors"
                    >
                        <StopIcon /> Disconnect
                    </button>
                ) : (
                   <div className="flex gap-2 text-slate-500 justify-center text-xs">
                       <span className="flex items-center gap-1"><CameraIcon /> Ready</span>
                       <span className="flex items-center gap-1"><MicIcon /> Ready</span>
                   </div>
                )}
            </div>
        </div>

      </main>
    </div>
  );
};

export default App;
