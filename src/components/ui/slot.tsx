import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Minimal `asChild` implementation: merges the wrapper's props onto its single
 * child element. Avoids pulling in a component library for one behaviour.
 */
export function Slot({
  children,
  className,
  ...props
}: { children?: ReactNode; className?: string } & Record<string, unknown>) {
  const child = Children.only(children) as ReactElement<{ className?: string }>;
  if (!isValidElement(child)) return null;

  return cloneElement(child, {
    ...props,
    className: cn(className, child.props.className),
  } as never);
}
