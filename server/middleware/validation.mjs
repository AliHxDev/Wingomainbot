export function validate(schema, source='body') {
  return (req,res,next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid request' });
    req[source] = parsed.data;
    next();
  };
}
