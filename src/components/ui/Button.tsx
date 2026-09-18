import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] glow-primary-strong",
        secondary:
          "border border-border bg-secondary/70 text-secondary-foreground hover:bg-secondary",
        outline: "border border-border bg-transparent text-foreground hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        destructive:
          "border border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/25",
        link: "text-primary underline-offset-2 hover:underline",
      },
      size: {
        xs: "h-6 rounded px-2 text-[10px]",
        sm: "h-7 rounded px-2.5 text-[11px]",
        md: "h-9 px-3.5 text-xs",
        lg: "h-10 rounded-lg px-5 text-sm",
        icon: "h-8 w-8 rounded-md",
        "icon-sm": "h-7 w-7 rounded",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { buttonVariants };
