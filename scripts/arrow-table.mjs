import * as arrow from "apache-arrow";
import schemas from "../src/lc-schemas.json" with { type: "json" };

// Encode the draft's ordered, explicitly nullable baseline schemas.
export function encodeTable(dataset, rows, releaseId, metadata = {}) {
  const fields = schemas[dataset].map(
    ({ name, type, nullable }) =>
      new arrow.Field(name, new arrow[type](), nullable),
  );
  const vectors = fields.map((field) =>
    arrow.vectorFromArray(
      rows.map(
        (row) =>
          row[field.name] ??
          (field.nullable ? null : field.type instanceof arrow.Utf8 ? "" : 0),
      ),
      field.type,
    ),
  );
  const schema = new arrow.Schema(
    fields,
    new Map(
      Object.entries({
        schemaVersion: "2-alpha",
        releaseId,
        dataset,
        ...metadata,
      }),
    ),
  );
  const batch = new arrow.RecordBatch(
    schema,
    arrow.makeData({
      type: new arrow.Struct(fields),
      length: rows.length,
      children: vectors.map((vector) => vector.data[0]),
    }),
  );
  return arrow.tableToIPC(new arrow.Table(batch), "file");
}
