import { pageItems } from "./events/cache";

/** Page buttons for a newest-first list: "Newer" goes towards page 1. */
export function Pagination({
  page,
  totalPages,
  onPage,
  disabled = false,
  label,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  disabled?: boolean;
  label: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" onClick={() => onPage(page - 1)} disabled={disabled || page <= 1}>
        ‹ Newer
      </button>
      {pageItems(page, totalPages).map((item, i) =>
        item === "gap" ? (
          <span key={`gap-${i}`} className="muted" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className={item === page ? "active" : undefined}
            aria-current={item === page ? "page" : undefined}
            aria-label={`Page ${item}`}
            onClick={() => item !== page && onPage(item)}
            disabled={disabled && item !== page}
          >
            {item}
          </button>
        ),
      )}
      <button type="button" onClick={() => onPage(page + 1)} disabled={disabled || page >= totalPages}>
        Older ›
      </button>
    </nav>
  );
}
