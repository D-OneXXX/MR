import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      type={type}
      className={cn(
        "h-10 w-full min-w-0 rounded-full border border-border bg-card px-4 text-sm text-foreground shadow-none outline-none transition-[border-color,box-shadow,transform] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
