import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Live bot workers. The API assigns new interviews to the least-loaded fresh bot; a bot whose
 * heartbeat stops is removed by TTL, and its interviews are claimed by another bot.
 */
const botInstanceSchema = new Schema(
  {
    botId: { type: String, required: true, unique: true },
    host: { type: String, required: true },
    capacity: { type: Number, required: true },
    activeInterviews: { type: Number, default: 0 },
    lastSeenAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'bot_instances' },
);
botInstanceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 60 });

export type BotInstance = InferSchemaType<typeof botInstanceSchema>;
export const BotInstanceModel = model('BotInstance', botInstanceSchema);

export const botRegistry = {
  async heartbeat(bot: {
    botId: string;
    host: string;
    capacity: number;
    activeInterviews: number;
  }) {
    await BotInstanceModel.updateOne(
      { botId: bot.botId },
      { $set: { ...bot, lastSeenAt: new Date() } },
      { upsert: true },
    );
  },

  async remove(botId: string): Promise<void> {
    await BotInstanceModel.deleteOne({ botId });
  },

  /** Least-loaded bot that heartbeated recently and has spare capacity. */
  pickLeastLoaded(staleAfterMs: number): Promise<BotInstance | null> {
    return BotInstanceModel.findOne({
      lastSeenAt: { $gte: new Date(Date.now() - staleAfterMs) },
      $expr: { $lt: ['$activeInterviews', '$capacity'] },
    })
      .sort({ activeInterviews: 1 })
      .lean<BotInstance>();
  },
};
