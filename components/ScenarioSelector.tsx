import React from 'react';
import { SCENARIOS } from '../constants';
import { Scenario } from '../types';

interface ScenarioSelectorProps {
  selectedId: string;
  onSelect: (scenario: Scenario) => void;
  disabled: boolean;
}

const ScenarioSelector: React.FC<ScenarioSelectorProps> = ({ selectedId, onSelect, disabled }) => {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Mission Context</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            onClick={() => onSelect(scenario)}
            disabled={disabled}
            className={`p-3 rounded-lg border text-left transition-all ${
              selectedId === scenario.id
                ? 'bg-blue-600/20 border-blue-500 ring-1 ring-blue-500'
                : 'bg-slate-800 border-slate-700 hover:border-slate-500'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <div className={`font-bold ${selectedId === scenario.id ? 'text-blue-400' : 'text-slate-200'}`}>
              {scenario.name}
            </div>
            <div className="text-xs text-slate-400 mt-1 line-clamp-1">
              {scenario.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ScenarioSelector;
