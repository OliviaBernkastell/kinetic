export interface LogEntry {
  timestamp: Date;
  sender: 'user' | 'ai' | 'system';
  message: string;
  type?: 'text' | 'audio' | 'alert';
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  systemInstruction: string;
}

export interface AudioVisualizerData {
  inputVolume: number;
  outputVolume: number;
}
