"use client";

import { useId } from "react";
import { cn } from "@/shared/utils/cn";

export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
  id,
  ...props
}) {
  // Label tanpa htmlFor tidak terasosiasi dengan kotaknya: mengklik label tidak
  // memfokus input, dan pembaca layar tidak menyebut namanya saat kotak itu
  // difokus. `useId` dipakai kalau pemanggil tidak memberi id, sehingga setiap
  // Input selalu punya pasangan label-input yang benar.
  const generatedId = useId();
  const inputId = id || generatedId;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted">
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </div>
        )}
        <input
          id={inputId}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={errorId}
          className={cn(
            "w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
            "border border-transparent placeholder-text-muted/70",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
            "transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed",
            // iOS zoom fix
            "text-[16px] sm:text-sm",
            icon && "pl-10",
            error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
            inputClassName
          )}
          {...props}
        />
      </div>
      {error && (
        <p id={errorId} className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
