export default function Pagination({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil((total || 0) / (limit || 20)));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center gap-3 text-sm">
      <button type="button" className="btn-quiet px-3 py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="text-fog">
        Page {page} of {pages} ({total} total)
      </span>
      <button type="button" className="btn-quiet px-3 py-1" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
