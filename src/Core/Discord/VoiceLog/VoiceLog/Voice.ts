import { unlinkSync as deleteFile, readdirSync as readDir } from 'node:fs'
import { extname } from 'node:path'
import type { VoiceChannel } from '@projectdysnomia/dysnomia'
import waitUntil from 'async-wait-until'
import type { CommandContext, MessageEmbedOptions } from 'slash-create'
import type { ILogObj, Logger } from 'tslog'
import { MEMBER_EVENTS, type TTSRequest } from '../../../../Audio/Audio'
import { instances } from '../../../../Utils/Instances'
import type { DbServerConfigManager } from '../../../SQLite/db/ServerConfig'
import type { Discord } from '../../Core'
import { DiscordVoice } from '../../Core/Voice'
import type { VoiceLog } from '../VoiceLog'

export class VoiceLogVoice {
  private updateLock = false
  private discord: Discord
  private audios: { [key: string]: DiscordVoice } = {}
  private logger: Logger<ILogObj>
  private serverConfig: DbServerConfigManager

  constructor(voiceLog: VoiceLog, discord: Discord) {
    this.discord = discord
    this.logger = voiceLog.logger.getSubLogger({ name: 'Voice' })
    this.serverConfig = voiceLog.serverConfig
  }

  public getCurrentVoice(guildId: string): DiscordVoice | undefined {
    const voice = this.audios[guildId]
    if (!voice) {
      const botVoice = this.discord.client.voiceConnections.get(guildId)
      if (botVoice?.ready) {
        if (botVoice.channelID) this.audios[guildId] = new DiscordVoice(this.discord, botVoice.channelID, botVoice)
        return this.audios[guildId]
      }
      return undefined
    }
    if (!voice.isReady()) {
      this.destroy(guildId)
      return undefined
    }

    return this.audios[guildId]
  }

  public async join(guildId: string, channelId: string, updateDatabase = false, playJoin = false): Promise<DiscordVoice | undefined> {
    if (this.audios[guildId]) {
      if (!this.audios[guildId].isReady() && !this.audios[guildId].init) {
        this.destroy(guildId)
      } else if (this.audios[guildId].channelId !== channelId) {
        this.audios[guildId].switchChannel(channelId)

        if (updateDatabase) {
          this.serverConfig.updateLastVoiceChannel(guildId, '')
          this.serverConfig.updateCurrentVoiceChannel(guildId, channelId)
        }

        if (playJoin) instances.audio.announceMoved(this.audios[guildId].playback)
        return this.audios[guildId]
      } else {
        return this.audios[guildId]
      }
    }

    this.audios[guildId] = new DiscordVoice(this.discord, channelId)
    try {
      await waitUntil(() => this.audios[guildId]?.isReady())
    } catch (error) {
      this.logger.error('Voice timed out:', error)
      return
    }
    if (updateDatabase) {
      this.serverConfig.updateLastVoiceChannel(guildId, '')
      this.serverConfig.updateCurrentVoiceChannel(guildId, channelId)
    }

    if (playJoin) instances.audio.announceReady(this.audios[guildId].playback)

    return this.audios[guildId]
  }

  public async destroy(guildId: string, updateDatabase = false) {
    this.audios[guildId].destroy()
    delete this.audios[guildId]
    if (updateDatabase) {
      this.serverConfig.updateLastVoiceChannel(guildId, '')
      this.serverConfig.updateCurrentVoiceChannel(guildId, '')
    }
  }

  private async sleep(guildId: string, channelId: string) {
    this.logger.info(`No user in ${channelId}, sleeping...`)
    this.destroy(guildId)
    this.serverConfig.updateLastVoiceChannel(guildId, channelId)
    this.serverConfig.updateCurrentVoiceChannel(guildId, '')
  }

  public async end() {
    for (const guildId in this.audios) {
      this.destroy(guildId)
    }
  }

  public async refreshCache(context: CommandContext | undefined) {
    if (this.updateLock) {
      await context?.send({
        embeds: [
          {
            title: 'Operation skipped',
            color: 13632027,
            description: 'Currently refreshing in progress...'
          } as MessageEmbedOptions
        ],
        ephemeral: true
      })

      return
    }
    this.updateLock = true
    this.logger.info('Starting cache refresh...')
    const title = '➡️ Refreshing Caches'
    let seekCounter = 0
    let seekFilename = ''
    let seekDone = false
    let seekField = {
      name: `${seekDone ? '✅' : '➡️'} Seeking for files ...${seekDone ? ' Done' : ''}`,
      value: `${seekDone || seekCounter === 0 ? '' : `Current ${seekFilename}, `} Seeked ${seekCounter} files. `
    }
    let progressMessage = this.genProgressMessage(title, [seekField])
    await context?.send({ embeds: [progressMessage] })
    let progressCount = 0
    let progressTotal = 0
    const ttsList: string[] = []
    const requests: TTSRequest[] = [...instances.audio.systemRequests()]
    progressTotal += 2
    const files = readDir('assets/')
    files.forEach((file) => {
      if (extname(file) === '.json') {
        seekCounter++
        seekFilename = file
        seekField = {
          name: `${seekDone ? '✅' : '➡️'} Seeking for files ...${seekDone ? ' Done' : ''}`,
          value: `${seekDone || seekCounter === 0 ? '' : `Current ${seekFilename}, `} Seeked ${seekCounter} files. `
        }
        const config = instances.audio.readMemberConfig(`assets/${file}`)
        if (!config) return
        for (const type of MEMBER_EVENTS) {
          const request = instances.audio.memberRequest(config, type)
          if (!request) continue
          progressTotal++
          requests.push(request)
        }
      }
    })
    seekDone = true
    seekField = {
      name: `${seekDone ? '✅' : '➡️'} Seeking for files ...${seekDone ? ' Done' : ''}`,
      value: `${seekDone || seekCounter === 0 ? '' : `Current ${seekFilename}, `} Seeked ${seekCounter} files. `
    }
    for (const request of requests) {
      progressCount++
      const description = `${request.text} in ${request.lang}${request.voice ? ` with voice ${request.voice}` : ''}`
      const progressField = {
        name: '➡️ Processing texts...',
        value: `(${progressCount}/${progressTotal}) ${description}`
      }
      progressMessage = this.genProgressMessage(title, [seekField, progressField])
      await context?.editOriginal({ embeds: [progressMessage] })
      const fileName = await instances.audio.synthesize(request)
      this.logger.info(`(${progressCount}/${progressTotal}) ${description} -> ${fileName}`)
      if (fileName !== null) ttsList.push(fileName)
      await new Promise((res) => setTimeout(res, 500))
    }
    const progressField = {
      name: '✅ Processing files... Done',
      value: `Processed ${progressTotal} texts.`
    }
    let cacheRemoveCount = 0
    let cacheField = {
      name: '➡️ Removing unused cache...',
      value: cacheRemoveCount === 0 ? 'Seeking...' : `Removed ${cacheRemoveCount} unused ${cacheRemoveCount === 1 ? 'cache' : 'caches'}.`
    }
    progressMessage = this.genProgressMessage(title, [seekField, progressField, cacheField])
    await context?.editOriginal({ embeds: [progressMessage] })
    const cacheFiles = readDir('caches/')
    cacheFiles.forEach(async (file) => {
      if (!ttsList.includes(`./caches/${file}`)) {
        deleteFile(`./caches/${file}`)
        this.logger.info(`Deleted unused file ./caches/${file}`)
        cacheRemoveCount++
        progressMessage = this.genProgressMessage(title, [seekField, progressField, cacheField])
        await context?.editOriginal({ embeds: [progressMessage] })
      }
    })
    cacheField = {
      name: '✅ Removing unused cache... Done',
      value: cacheRemoveCount === 0 ? 'No unused caches found.' : `Removed ${cacheRemoveCount} unused ${cacheRemoveCount === 1 ? 'cache' : 'caches'}.`
    }
    progressMessage = this.genProgressMessage('✅ Refresh Caches Done', [seekField, progressField, cacheField], true)
    await context?.editOriginal({ embeds: [progressMessage] })
    this.updateLock = false
  }

  private genProgressMessage(title: string, fields: Array<{ name: string; value: string }>, isDone = false) {
    return {
      color: isDone ? 4289797 : 16312092,
      title,
      fields
    } as MessageEmbedOptions
  }

  public async autoLeaveChannel(oldChannel: VoiceChannel | undefined, newChannel: VoiceChannel | undefined, guildId: string): Promise<string | undefined> {
    let channelToCheck: VoiceChannel | undefined

    const voice = this.getCurrentVoice(guildId)
    const data = await this.serverConfig.get(guildId)

    if (voice?.isReady()) {
      channelToCheck = oldChannel?.id === voice?.channelId ? oldChannel : newChannel?.id === voice?.channelId ? newChannel : undefined
    } else if (data) {
      channelToCheck = oldChannel?.id === data.lastVoiceChannel ? oldChannel : newChannel?.id === data.lastVoiceChannel ? newChannel : undefined
    }

    if (!channelToCheck) return

    let noUser = true

    channelToCheck.voiceMembers?.forEach((user) => {
      if (!user.bot) {
        noUser = false
      }
    })

    if (noUser) {
      if (voice) {
        await this.sleep(guildId, channelToCheck.id)
      }
    } else {
      let connection = await this.join(guildId, channelToCheck.id, true)
      for (let i = 0; i < 5; ++i) {
        if (!connection) {
          this.logger.warn(`Auto reconnect failed, retrying (${i + 1} / 5)...`)
          await this.destroy(guildId)
          connection = await this.join(guildId, channelToCheck.id, true)
        } else {
          return channelToCheck.id
        }
      }

      this.logger.error('Auto reconnect fails after 5 tries')
    }
  }
}
