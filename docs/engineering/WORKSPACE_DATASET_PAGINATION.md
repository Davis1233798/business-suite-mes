# Workspace dataset table pagination

Only MES workspace dataset tables use client-side pagination, with 50 rows per page over the existing loaded, organization-authorized result set. The API query cap and authorization remain unchanged. Search filters the loaded rows and returns to page one when its result set changes.

PrintCenter documents remain complete and unpaginated, including long production-report and work-order line lists. Compact summaries remain capped at five rows. Pagination does not change MES business forms, barcode labels, form drafts, authentication state, or business API behavior.

The browser fixture covers a 500-row workspace dataset, first/next/last navigation, search reset, preview-state retention, Traditional Chinese controls, a 390px viewport, and a 675-line print document.

TanStack Table v9 client-side pagination uses `useTable`, `tableFeatures`, `rowPaginationFeature`, and `createPaginatedRowModel`. See the [pagination guide](https://tanstack.com/table/latest/docs/framework/react/guide/pagination) and [pagination example](https://tanstack.com/table/latest/docs/framework/react/examples/pagination).
