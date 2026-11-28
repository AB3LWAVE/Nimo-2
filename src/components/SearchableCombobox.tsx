import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { filterComboboxSuggestions } from '../utils/createCombobox';

interface SearchableComboboxProps {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  suggestions: readonly string[];
  placeholder?: string;
  closeSignal?: number;
}

export function SearchableCombobox({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  closeSignal = 0,
}: SearchableComboboxProps) {
  const inputId = useId();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hasTypedFilter, setHasTypedFilter] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const visibleSuggestions = hasTypedFilter
    ? filterComboboxSuggestions(suggestions, value)
    : [...suggestions];

  useEffect(() => {
    setIsOpen(false);
    setHasTypedFilter(false);
    setHighlightedIndex(-1);
  }, [closeSignal]);

  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setHasTypedFilter(false);
        setHighlightedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleOutsideMouseDown);
    return () => document.removeEventListener('mousedown', handleOutsideMouseDown);
  }, [isOpen]);

  const selectOption = (option: string) => {
    onChange(option);
    setIsOpen(false);
    setHasTypedFilter(false);
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (isOpen) {
        e.stopPropagation();
        setIsOpen(false);
        setHasTypedFilter(false);
        setHighlightedIndex(-1);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(visibleSuggestions.length > 0 ? 0 : -1);
      } else if (visibleSuggestions.length > 0) {
        setHighlightedIndex((prev) => (prev + 1) % visibleSuggestions.length);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (isOpen && visibleSuggestions.length > 0) {
        setHighlightedIndex((prev) =>
          prev <= 0 ? visibleSuggestions.length - 1 : prev - 1
        );
      }
      return;
    }

    if (e.key === 'Enter' && isOpen) {
      if (highlightedIndex >= 0 && highlightedIndex < visibleSuggestions.length) {
        e.preventDefault();
        selectOption(visibleSuggestions[highlightedIndex]);
      } else {
        setIsOpen(false);
        setHasTypedFilter(false);
      }
    }
  };

  const normalizedValue = value.trim().toLowerCase();
  const isCustomValue =
    normalizedValue.length > 0 &&
    !suggestions.some((opt) => opt.toLowerCase() === normalizedValue);

  return (
    <div ref={containerRef} className="relative">
      <label
        htmlFor={inputId}
        className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
      >
        {label}
      </label>

      <div className="relative flex items-center">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          value={value}
          placeholder={placeholder}
          onFocus={() => {
            setIsOpen(true);
            setHasTypedFilter(false);
            setHighlightedIndex(-1);
          }}
          onClick={() => {
            setIsOpen(true);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setHasTypedFilter(true);
            setIsOpen(true);
            setHighlightedIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          className="w-full pl-3 pr-8 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500 transition-colors"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Toggle ${label} suggestions`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setIsOpen((prev) => !prev);
            setHasTypedFilter(false);
            setHighlightedIndex(-1);
          }}
          className="absolute right-2 p-1 rounded text-slate-400 hover:text-orange-600 dark:hover:text-amber-400 transition-colors"
        >
          <ChevronDown
            className={`w-4 h-4 transition-transform duration-150 ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute left-0 right-0 mt-1.5 z-30 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161C24] shadow-xl overflow-hidden"
        >
          <div className="max-h-52 overflow-y-auto py-1">
            {visibleSuggestions.length > 0 ? (
              visibleSuggestions.map((option, idx) => {
                const isSelected = option.toLowerCase() === normalizedValue;
                const isHighlighted = idx === highlightedIndex;
                return (
                  <button
                    key={option}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    onClick={() => selectOption(option)}
                    className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between transition-colors ${
                      isHighlighted || isSelected
                        ? 'bg-orange-50 dark:bg-orange-950/45 text-orange-700 dark:text-amber-300 font-medium'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/70'
                    }`}
                  >
                    <span className="capitalize">{option}</span>
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 text-orange-600 dark:text-amber-400 shrink-0" />
                    )}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400">
                No preset matches &ldquo;{value.trim()}&rdquo;. Press Enter or apply to use your custom {label.toLowerCase()}.
              </div>
            )}
          </div>

          {isCustomValue && visibleSuggestions.length > 0 && (
            <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
              Custom {label.toLowerCase()} active: <span className="font-medium text-orange-600 dark:text-amber-400">{value.trim()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
