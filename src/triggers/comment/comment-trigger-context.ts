import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { Comment, TriggerContext } from "@devvit/public-api";
import {
  getUserCanAward,
    getUserIsAltUser,
    getUserIsSuperuser,
    isModerator,
} from "../../utils/user-utilities.js";
import { logger } from "../../logger.js";

// src/triggers/comment/comment-trigger-context.ts
export class CommentTriggerContext {
    private _event: CommentSubmit | CommentUpdate | undefined = undefined;
    private _context: TriggerContext | undefined = undefined;
    private _awarder: string | undefined = undefined;
    private _subredditName: string | undefined = undefined;
    private _isMod: boolean = false;
    private _isAltUser: boolean = false;
    private _isSuperUser: boolean = false;
    private _userCanAward: boolean = false;
    // More properties...

    get userCanAward() {
      return this._userCanAward;
    }
    get awarder() {
        return this._awarder;
    }
    get isMod() {
        return this._isMod;
    }
    get isSuperUser() {
        return this._isSuperUser;
    }
    get isAltUser() {
        return this._isAltUser;
    }
    // More getters where needed...

    public async init(
        event: CommentSubmit | CommentUpdate,
        context: TriggerContext
    ) {
        if (!event.author) return;
        if (!event.subreddit) return;
        this._event = event;
        this._context = context;
        this._awarder = event.author.name;
        this._subredditName = event.subreddit.name;
        this._isMod = await isModerator(
            context,
            this._subredditName,
            this._awarder
        );
        this._isAltUser = await getUserIsAltUser(context, this._awarder);
        this._isSuperUser = await getUserIsSuperuser(
            context,
            this._awarder
        );
        this._userCanAward = await getUserCanAward(context, this._awarder);
        // More context setup
    }
}

export async function getParentComment(event: CommentSubmit | CommentUpdate, devvitContext: TriggerContext): Promise<Comment | undefined> {
    let parentComment: Comment | undefined;
    if (!event.comment) return undefined;
    try {
        parentComment = await devvitContext.reddit.getCommentById(
            event.comment.parentId
        );
        return parentComment;
    } catch {
        parentComment = undefined;
    }
    if (!parentComment) {
        logger.warn("❌ Parent comment not found.");
        return undefined;
    }
}