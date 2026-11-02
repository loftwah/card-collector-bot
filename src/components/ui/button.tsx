import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[2px] text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-[var(--ink)] text-[var(--paper)] hover:bg-[var(--green)]",
        secondary: "border border-[var(--line-strong)] bg-transparent text-[var(--ink)] hover:border-[var(--brass)] hover:bg-[var(--brass)]/5",
        ghost: "text-[var(--muted)] hover:bg-[var(--ink)]/5 hover:text-[var(--ink)]",
        danger: "border border-[var(--oxblood)]/40 text-[var(--oxblood)] hover:bg-[var(--oxblood)]/8",
        brass: "bg-[var(--brass)] text-[#141512] hover:bg-[var(--brass-bright)]",
      },
      size: {
        sm: "h-9 px-3 text-xs",
        md: "h-11 px-4",
        lg: "h-12 px-5 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
