/**********************************************************************************
 * This file defines the HelpQueueDisplayManager and the Help Queue class
 * HelpQueueDisplayManager manages the message that's in the #queue channels
 * HelpQueue impliments a queue for each channel and also various functions for it
 * .setRequired defines where the argument is required or ont
 **********************************************************************************/

import { Client, GuildMember, Message, MessageActionRow, MessageButton, TextChannel } from "discord.js";
import { MemberState, MemberStateManager } from "./member_state_manager";
import { UserError } from "./user_action_error";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AsciiTable = require('ascii-table');

export class HelpQueueDisplayManager {
    private client: Client
    private display_channel: TextChannel
    private queue_message: Message | null

    constructor(client: Client, display_channel: TextChannel, queue_message: Message | null) {
        this.client = client
        this.display_channel = display_channel
        this.queue_message = queue_message
    }

    // Returns a table of the list of people in queue in text form that can be used in a message
    private GetQueueText(queue: HelpQueue, queue_members: MemberState[]): string {
        const quant_prase = queue.length == 1 ? 'is 1 person' : `are ${queue.length} people`
        const status_line = `The queue is **${queue.is_open ? 'OPEN' : 'CLOSED'}**. There ${quant_prase} in the queue.\n`
        if (queue.length > 0) {
            const table = new AsciiTable()
            table.setHeading('Position', 'Username')
            queue_members.forEach((state, idx) => table.addRow(idx + 1, state.member.user.username))
            return status_line + '```\n' + table.toString() + '\n```'
        }
        return status_line
    }

    EnsureQueueSafe(): Promise<void> {
        return this.display_channel.messages.fetchPinned()
            .then(messages => messages.filter(msg => msg.author == this.client.user))
            .then(messages => {
                if (messages.size > 1) {
                    messages.forEach(message => message.delete())
                    messages.clear()
                    this.queue_message = null

                } else if (messages.size === 0) {
                    this.queue_message = null
                }
            })
    }

    // Updates the queue text. Called when queue is open or closed, or when someone joins or leaves the queue
    async OnQueueUpdate(queue: HelpQueue, queue_members: MemberState[]): Promise<void> {
        const message_text = this.GetQueueText(queue, queue_members)
        const joinLeaveButtons = new MessageActionRow()
            .addComponents(
                new MessageButton()
                    .setCustomId('join ' + queue.name)
                    .setEmoji('✅')
                    .setDisabled(!queue.is_open)
                    .setLabel('Join Queue')
                    .setStyle('SUCCESS')
            )
            .addComponents(
                new MessageButton()
                    .setCustomId('leave ' + queue.name)
                    .setEmoji('❎')
                    .setDisabled(!queue.is_open)
                    .setLabel('Leave Queue')
                    .setStyle('DANGER')
            )
        const notifButtons = new MessageActionRow()
            .addComponents(
                new MessageButton()
                    .setCustomId('notif ' + queue.name)
                    .setEmoji('🔔')
                    .setDisabled(queue.is_open)
                    .setLabel('Notify When Open')
                    .setStyle('PRIMARY')
            )
            .addComponents(
                new MessageButton()
                    .setCustomId('removeN ' + queue.name)
                    .setEmoji('🔕')
                    .setDisabled(queue.is_open)
                    .setLabel('Remove Notifications')
                    .setStyle('PRIMARY')
            )

        // If queue_message exists, edit it
        // Else, send a new message
        if (this.queue_message === null) {
            this.EnsureQueueSafe()
            await this.display_channel.send({
                content: message_text,
                components: [joinLeaveButtons, notifButtons]
            }).then(message => message.pin()).then(message => this.queue_message = message)
        } else {
            await this.queue_message.edit({
                content: message_text,
                components: [joinLeaveButtons, notifButtons]
            }).catch()
        }
    }
}

export class HelpQueue {
    private queue: MemberState[] = []
    readonly name: string
    private display_manager: HelpQueueDisplayManager
    private member_state_manager: MemberStateManager
    private helpers: Set<GuildMember> = new Set()
    private notif_queue: Set<GuildMember> = new Set()

    constructor(name: string, display_manager: HelpQueueDisplayManager, member_state_manager: MemberStateManager) {
        this.name = name
        this.display_manager = display_manager
        this.member_state_manager = member_state_manager
    }

    get length(): number {
        return this.queue.length
    }

    get is_open(): boolean {
        return this.helpers.size > 0
    }

    Has(member: GuildMember): boolean {
        return this.queue.find(queue_member => queue_member.member == member) !== undefined
    }

    async Clear(): Promise<void> {
        this.queue.forEach(member => member.TryRemoveFromQueue(this))
        this.queue = []
        await this.UpdateDisplay()
    }

    async UpdateDisplay(): Promise<void> {
        await this.display_manager.OnQueueUpdate(this, this.queue)
    }

    async EnsureQueueSafe(): Promise<void> {
        await this.display_manager.EnsureQueueSafe()
    }

    // Adds a Helper to the list of available helpers for this queue. called by /start
    async AddHelper(member: GuildMember, mute_notifs: boolean): Promise<void> {
        if (this.helpers.has(member)) {
            console.warn(`Queue ${this.name} already has helper ${member.user.username}. Ignoring call to AddHelper`)
            return
        }
        this.helpers.add(member)

        // if helper list size goes from 1, means queue just got open. 
        // when it goes from 2 to 1, not a possible case since you can't press the notif button unless the queue is closed
        // hence, in that case, there is no-one in the notif_queue, and hence no-one is messaged
        if (this.helpers.size === 1 && mute_notifs !== true) {
            await this.NotifyUsers()
        }
        await this.UpdateDisplay()
    }

    // Removes a Helper to the list of available helpers for this queue. called by /stop
    async RemoveHelper(member: GuildMember): Promise<void> {
        if (!this.helpers.has(member)) {
            console.warn(`Queue ${this.name} does not have helper ${member.user.username}. Ignoring call to RemoveHelper`)
            return
        }
        this.helpers.delete(member)
        await this.UpdateDisplay()
    }

    // Adds a user to this queue
    async Enqueue(member: GuildMember): Promise<void> {
        const user_state = this.member_state_manager.GetMemberState(member)
        user_state.TryAddToQueue(this)
        this.queue.push(user_state)
        if (this.queue.length == 1) {
            // The queue went from having 0 people to having 1.
            // Notify helpers of this queue that someone has joined.
            await Promise.all(
                Array.from(this.helpers)
                    .map(helper => helper.send(`Heads up! <@${member.user.id}> has joined "${this.name}".`)))
        }
        await this.UpdateDisplay()
    }

    async Remove(member: GuildMember): Promise<void> {
        // Removes a user from this queue, called by /leave
        const user_state = this.member_state_manager.GetMemberState(member)
        user_state.TryRemoveFromQueue(this)
        this.queue = this.queue.filter(waiting_user => waiting_user != user_state)

        await this.UpdateDisplay()
    }

    async Dequeue(): Promise<MemberState> {
        // Removes next user from this queue, called by /next
        const user_state = this.queue.shift()
        if (user_state === undefined) {
            throw new UserError('Empty queue')
        }
        user_state.TryRemoveFromQueue(this)

        await this.UpdateDisplay()
        return user_state
    }

    async AddToNotifQueue(member: GuildMember): Promise<void> {
        //Adds member to notification queue
        this.notif_queue.add(member)
    }

    async RemoveFromNotifQueue(member: GuildMember): Promise<void> {
        //Adds member to notification queue
        this.notif_queue.delete(member)
    }

    async NotifyUsers(): Promise<void> {
        //Notifys the users in the notification queue that the queue is now open
        if (this.notif_queue.size == 0)
            return
        this.notif_queue.forEach(member => member.send("Hey! The `" + this.name + "` queue is now open!"))
        this.notif_queue.clear();
    }

    // Returns the person at the front of this queue
    Peek(): MemberState | undefined {
        if (this.queue.length == 0) {
            return undefined
        } else {
            return this.queue[0]
        }
    }
}
