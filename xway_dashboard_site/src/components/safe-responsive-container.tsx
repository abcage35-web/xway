import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { ResponsiveContainer as RechartsResponsiveContainer } from "recharts";

type SafeResponsiveContainerProps = ComponentProps<typeof RechartsResponsiveContainer>;
type ContainerSize = { width: number; height: number };

export function ResponsiveContainer({ children, initialDimension, ...props }: SafeResponsiveContainerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ContainerSize | null>(null);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }

    const update = () => {
      const rect = node.getBoundingClientRect();
      const nextSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((current) => {
        if (nextSize.width <= 1 || nextSize.height <= 1) {
          return null;
        }
        if (current?.width === nextSize.width && current.height === nextSize.height) {
          return current;
        }
        return nextSize;
      });
    };

    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="h-full min-h-0 w-full min-w-0">
      {size ? (
        <RechartsResponsiveContainer {...props} width={size.width} height={size.height} initialDimension={initialDimension ?? size}>
          {children}
        </RechartsResponsiveContainer>
      ) : null}
    </div>
  );
}
