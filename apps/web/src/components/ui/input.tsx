import type * as React from 'react';
import { cn } from '@/lib/utils';

const fieldClasses =
  'border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(fieldClasses, className)} {...props} />;
}

/** Native select styled like Input: accessible and keyboard-friendly with no extra dependency. */
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(fieldClasses, 'pr-8', className)} {...props} />;
}

export { Input, NativeSelect };
