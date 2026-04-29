import { Router } from "express";
import { getTrackedGroups, setTrackedGroups } from "../../db/mongo";

const router = Router();

router.get("/tracked", async (_req, res) => {
  try {
    const groups = await getTrackedGroups();
    res.json({ groups });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/tracked", async (req, res) => {
  try {
    const { groups } = req.body;
    if (!Array.isArray(groups)) {
      return res.status(400).json({ error: "groups must be an array of {jid,name}" });
    }
    const bad = groups.find(
      (g: any) => !g || typeof g.jid !== "string" || typeof g.name !== "string"
    );
    if (bad !== undefined) {
      return res
        .status(400)
        .json({ error: "each group must be { jid: string, name: string }" });
    }
    await setTrackedGroups(groups);
    const updated = await getTrackedGroups();
    res.json({ groups: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
