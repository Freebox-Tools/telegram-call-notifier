// Importer les libs
const { FreeboxClient } = require("freebox-wrapper");
const fs = require('fs');
require('dotenv').config();
const { Telegraf } = require('telegraf')
var bot = new Telegraf(process.env.BOT_TOKEN)
var id = process.env.TELEGRAM_ID //TODO: ne plus utiliser ça
var ffmpeg = require('ffmpeg');
const { exec } = require("child_process");
const fetch = require('node-fetch');

// Supabase
var { createClient } = require("@supabase/supabase-js");
var supabase = createClient(process.env.SUPABASE_LINK, process.env.SUPABASE_PUBLIC_KEY)

// Obtenir tout les utilisateurs
var users = []
async function getSupabaseUsers() {
	// On obtient les utilisateurs
	var { data, error } = await supabase.from("users").select("*")
	if (error) return console.log(error)
	users = data // on enregistre

	// On supprime les boxs déjà connectées qui n'existent plus
	freeboxs = freeboxs.filter(e => users.find(f => f.userId == e.userId && f.id == e.id))

	// On s'authentifier sur toutes les boxs pas encore connectées
	for (const user of users) {
		// Si on a déjà cette box, on passe
		if (freeboxs.find(e => e.userId == user.userId && e.id == user.id)) continue

		// On initialise le client
		const freebox = new FreeboxClient({
			appId: user.appId,
			appToken: user.appToken,
			apiDomain: user.apiDomain,
			httpsPort: user.httpsPort
		})

		// On s'authentifie
		var response = await freebox.authentificate()
		if (!response?.success) {
			// On prévient l'utilisateur
			bot.telegram.sendMessage(user.userId, "Nous n'avons pas pu vous connecter à votre Freebox. Nous réessayerons plus tard. Si le problème persiste, veuillez vous déconnecter et vous reconnecter.").catch(err => {
				console.log(`Impossible de contacter l'utilisateur ${user.userId} : `, err)
				return disconnectBox(user.userId, user.id)
			})
		}
		else console.log(`(nouvel utilisateur) Connecté à la Freebox ${getFreeboxName(user.boxModel)} pour l'utilisateur ${user.userId}.`)

		// On ajoute la Freebox à la liste
		freeboxs.push({
			client: freebox,
			userId: user.userId,
			chatId: user.chatId,
			lastVoicemailId: user.lastVoicemailId,
			id: user.id
		})

		// On attend 1 seconde avant de continuer
		await new Promise(r => setTimeout(r, 1000));
	}

	// On retourne que c'est bon
	return true
}

// Mettre à jour les données périodiquement
setInterval(() => getSupabaseUsers(), 1000 * 60 * 5)

// Liste des boxs connectées
var freeboxs = []

// TODO: on précisera dans Le README qu'il faut pas leak la SUPABASE_PUBLIC_KEY mm si le nom indique qu'elle est publique, c'est pas vrm le cas
// TODO: on précisera aussi dans le README d'activer les RLS (voir celle déjà définit dans la base de données)

// TODO: on testera que le bot NE marche PAS sur des groupes / sur des canaux

// Liste des réponses d'utilisateur qu'on attend
var waitingForReplies = []

// Liste des noms des Freebox
function getFreeboxName(name) {
	console.log(name)
	if (name.includes("Server Mini")) return "Mini 4K"
	if (name.includes("Delta") || name.includes("v7")) return "Delta"
	if (name.includes("Pop") || name.includes("v8")) return "Pop"
	if (name.includes("Révolution") || name.includes("Revolution") || name.includes("v6")) return "Révolution"
	if (name.includes("Server")) return "Server"
	return "Inconnue"
}

// Fonction pour déconnecter la box d'un utilisateur
async function disconnectBox(userId, boxId) {
	// On supprime les infos de l'utilisateur
	var { error } = await supabase.from("users").delete().match({ userId: userId })
	if (error) {
		var { error } = await supabase.from("users").delete().match({ id: boxId })
		if (error) return false
	}

	// On supprime la box de la liste
	freeboxs = freeboxs.filter(e => e.userId != userId && e.id != boxId)

	// On retourne les infos de l'utilisateur
	return true
}

// Si ffmpeg n'est pas installé avertir l'utilisateur	
exec("ffmpeg -version", (error) => {
	if (error) {
		console.warn("WARN: ffmpeg n'a pas été détecté dans votre système. Il se peut donc que vous ne puissiez pas envoyer de messages vocaux.")
	}
});

// Fonction principale
async function main() {
	// Connecter le bot
	bot.botInfo = await bot.telegram.getMe();
	console.log("Bot démarré en tant que @" + bot?.botInfo?.username || bot?.botInfo || bot);
	bot.launch()

	// Obtenir les utilisateurs Supabase
	await getSupabaseUsers()

	// Lancer le bot
	console.log(`Démarré ! ${freeboxs.length} freebox${freeboxs.length > 1 ? "s" : ""} connectée${freeboxs.length > 1 ? "s" : ""}.`)

	// Fonctions importantes qui s'exécutent en temps réel
	logCalls()
	logVoices()

	// Commande start du bot pour une première connexion en lui expliquant au fur et à mesure
	bot.command('start', (ctx) => {
		ctx.replyWithHTML(`
Bienvenue dans Freebox Call Notifier ! Ce bot vous permet de recevoir une notification lors d'un appel entrant sur votre Freebox.

Pour associer une Freebox à votre compte Telegram, vous devrez utiliser l'assistant de configuration via terminal sur un ordinateur connecté au même réseau que votre Freebox.

1. Assurez-vous d'avoir <a href="https://nodejs.dev/fr/download/">Node.js</a> installé sur votre ordinateur.
2. Ouvrez un terminal ("Invite de commandes" sur Windows 10).
3. Dans ce terminal, entrez la commande suivante : <code>npx freebox-notifier-cli</code>
4. Suivez les instructions affichées dans le terminal.

En cas de problème, vous pouvez contacter <a href="https://t.me/el2zay">el2zay</a>.
<i>Non-affilié à Free et Iliad.</i>`
			, { disable_web_page_preview: true, allow_sending_without_reply: true }).catch(err => { })
	})

	// Commande logout
	bot.command('logout', async (ctx) => {
		// On vérifie que l'utilisateur est bien connecté
		if (!users.find(e => e.userId == ctx.message.from.id)) return ctx.reply("Vous n'êtes pas connecté à une Freebox. Utiliser la commande /start pour débuter.").catch(err => { })

		// Créer un identifiant unique pour les boutons
		var id = Date.now();

		// Demander à l'utilisateur de confirmer
		var replyMarkup = {
			inline_keyboard: [
				[
					{
						text: "Se déconnecter",
						callback_data: `yes-${id}`
					},
					{
						text: "Annuler",
						callback_data: `no-${id}`
					},
				]
			]
		};

		// Afficher un message d'attention avec les boutons.
		ctx.replyWithHTML("⚠️ <b>ATTENTION :</b> Lors de la déconnexion, toutes les données enregistrées sur nos serveurs seront supprimées et vous ne serez plus notifié lors d'un appel entrant.\nSi vous souhaitez vous reconnecter plus tard, vous devrez recommencer le processus d'installation via terminal.\n\n<b>Êtes-vous sûr de vouloir vous déconnecter ?</b>", {
			reply_markup: replyMarkup
		}).catch(err => { })

		// Si on annule
		bot.action(`no-${id}`, async (ctx) => {
			// Répondre et supprimer le message
			ctx.answerCbQuery("Action annulé ! Vous ne serez pas déconnecté.").catch(err => { })
			ctx.deleteMessage().catch(err => { })
		})

		// Si on confirme
		bot.action(`yes-${id}`, async (ctx) => {
			// Supprimer les informations de la base de données
			await disconnectBox(ctx?.update?.callback_query?.from?.id)

			// Répondre et supprimer le message
			ctx.deleteMessage().catch(err => { })
			ctx.reply("Vous avez été déconnecté. Une attente de quelques minutes est nécessaire avant la suppression totale de vos données.").catch(err => { })
			await getSupabaseUsers() // On met à jour les utilisateurs
		})
	})

	// Commande voicemail
	bot.command('voicemail', async (ctx) => {
		if (!users.find(e => e.userId == ctx.message.from.id)) return ctx.reply("Vous n'êtes pas connecté à une Freebox. Utiliser la commande /start pour débuter.").catch(err => { })
		await sendVoicemail(ctx.from.id)
	})

	// Commande contact
	bot.command('contact', async (ctx) => {
		// On vérifie que l'utilisateur est bien connecté
		if (!users.find(e => e.userId == ctx.message.from.id)) return ctx.reply("Vous n'êtes pas connecté à une Freebox. Utiliser la commande /start pour débuter.").catch(err => { })

		// Si on a un argument, on envoie directement le contact
		if (ctx.message.text.split(" ").length > 1) {
			var name = ctx.message.text.split(" ")[1]
			return await getContact(name, ctx)
		}

		// Sinon, on demande à l'utilisateur d'envoyer le nom du contact
		ctx.reply("Veuillez envoyer le nom du contact à chercher.").catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "contact",
			ctx: ctx
		})
	})

	// Commande createcontact
	bot.command('createcontact', (ctx) => {
		// On vérifie que l'utilisateur est bien connecté
		if (!users.find(e => e.userId == ctx.message.from.id)) return ctx.reply("Vous n'êtes pas connecté à une Freebox. Utiliser la commande /start pour débuter.").catch(err => { })

		// Demander à l'utilisateur d'envoyer un message
		ctx.reply("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : Jean, 0123456789").catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "createcontact-via-cmd",
			ctx: ctx
		})
	})

	// Commande deletecontact
	bot.command('deletecontact', async (ctx) => {
		// On vérifie que l'utilisateur est bien connecté
		if (!users.find(e => e.userId == ctx.message.from.id)) return ctx.reply("Vous n'êtes pas connecté à une Freebox. Utiliser la commande /start pour débuter.").catch(err => { })

		// Si après deletecontact il y a un nom, on execute la fonction deleteContact
		if (ctx.message.text.split(" ").length > 1) {
			var name = ctx.message.text.split(" ")[1]
			return await deleteContact(name, ctx)
		}

		// Sinon, on demande à l'utilisateur d'envoyer le nom du contact
		ctx.reply("Veuillez envoyer le nom du contact à supprimer.").catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "deletecontact",
			ctx: ctx
		})
	})

	// Commande mynumber
	bot.command('mynumber', async (ctx) => {
		// On vérifie que l'utilisateur est bien connecté
		if (!users.find(e => e.userId == ctx.message.from.id)) return ctx.reply("Vous n'êtes pas connecté à une Freebox. Utiliser la commande /start pour débuter.").catch(err => { })

		ctx.reply("Votre numéro de téléphone fixe est le : " + await myNumber(ctx)).catch(err => { })
	})

	// Action du bouton "Créer un contact"
	bot.action('createcontact', async (ctx) => {
		// Déterminer le numéro de téléphone
		var message = ctx.callbackQuery.message.text
		var num = message.split("de")[1].split("(")[0].trim()

		// Si le numéro est masqué, ne rien faire
		if (num == "Numéro masqué") return ctx.answerCbQuery("Impossible de créer le contact puisque le numéro est masqué.").catch(err => { })

		// Demander le nom du contact
		ctx.reply(`Veuillez envoyer le nom du contact à ajouter au numéro "${num}"`).catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.callbackQuery.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.callbackQuery.from.id)
		waitingForReplies.push({
			userId: ctx.callbackQuery.from.id,
			created: Date.now(),
			type: "createcontact-via-btn",
			ctx: ctx,
			num: num
		})
	})

	bot.action('delete-voicemail', async (ctx) => {
		// Obtenir les infos sur l'utilisateur
		const userId = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id
		const freebox = freeboxs.find(e => e.userId == userId)

		// Récupérer les messages vocaux
		var response = await freebox?.client?.fetch({
			method: "GET",
			url: "v10/call/voicemail/",
			parseJson: true
		});
		count = response?.result?.length || 0

		// Récupérer le dernier
		response.result = response?.result?.sort((a, b) => b.date - a.date)
		response = response?.result?.[0] || null

		// Si on a pas de messages vocaux
		if (!response) return ctx.answerCbQuery("Vous n'avez aucun message vocal.").catch(err => { })

		// Supprimer le message vocal
		var { error } = await freebox?.client?.fetch({
			method: "DELETE",
			url: `v10/call/voicemail/${response.id}/`
		})

		// Si on a pas pu supprimer le vocal
		if (error) return ctx.answerCbQuery("Impossible de supprimer le message vocal : " + error.msg || error.message || error).catch(err => { })

		// Répondre en disant qu'il a bien été supprimé
		ctx.answerCbQuery(`Le message vocal a bien été supprimé. Il vous reste ${count - 1} message${count - 1 > 1 ? "s" : ""} vocal${count - 1 > 1 ? "s" : ""}.`).catch(err => { })
	})

	// Action du bouton "transcribe-voicemail"
	bot.action('transcribe-voicemail', async (ctx) => {
		var message = await ctx.reply("Vérification : Veuillez patienter").catch(err => { })
		// Récupérer l'id du message
		var messageId = message.message_id

		// Vérifier si python est installé
		const command = process.platform === 'win32' ? 'python' : 'python3';
		exec(`${command} --version`, (error, stdout, stderr) => {
			if (error) {
				// Modifier le message
				return ctx.editMessageText({
					chat_id: id,
					message_id: messageId,
					text: "Une erreur s'est produite lors de la vérification de la version de Python."
				})
			}
			if (!stdout.includes('Python 3')) {
				return ctx.editMessageText({
					chat_id: id,
					message_id: messageId,
					text: "Python 3 n'est pas installé sur votre système."
				})
			}
		});

		// Récupérer le chemin du fichier vocal
		const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${ctx.callbackQuery.message.audio.file_id}`);
		const data = await response.json();
		const filePath = data.result.file_path;


		// Récupérer le fichier vocal grâce a fetch
		const fileResponse = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`);
		const fileData = await fileResponse.buffer();

		// Ecrire les données du fichier
		fs.writeFileSync(`${messageId}.ogg`, fileData)

		// Executer le script python
		exec(`${command} transcribe.py ${messageId}.ogg`, (error, stdout, stderr) => {
			// Ajouter le bouton annuler
			replyMarkup = {
				inline_keyboard: [
					[
						{
							text: "Annuler",
							callback_data: `cancel-${messageId}`
						}
					]
				]
			};
			ctx.editMessageText({
				chat_id: id,
				message_id: messageId,
				text: "Transcription en cours...",
			})

			// Action du bouton annuler
			bot.action(`cancel-${messageId}`, async (ctx) => {
				// Supprimer le message
				ctx.deleteMessage().catch(err => { })
				// Supprimer le bouton annuler
				replyMarkup = null
				//Arrêter le script python
				process.kill()
				// Dire que ça a bien été annulé
				ctx.answerCbQuery("La transcription a bien été annulée.").catch(err => { })
				// Supprimer le fichier
				fs.unlinkSync(`${messageId}.ogg`)
				return
			})
			// Ajouter un bouton pour annuler
			if (error) return ctx.editMessageText("Une erreur s'est produite lors de l'exécution du script Python.", error).catch(err => { });
			if (stderr) return ctx.editMessageText("Une erreur s'est produite lors de l'exécution du script Python.", stderr).catch(err => { });
			// On envoie la transcription
			console.log(stdout)
			ctx.editMessageText({
				chat_id: id,
				message_id: messageId,
				text: `${stdout}`,
			})

			// Supprimer le bouton annuler
			replyMarkup = null
			// Supprimer le fichier
			fs.unlinkSync(`${messageId}.ogg`)
		});
	});

	// Action du bouton "Supprimer le contact"
	bot.action('deletecontact', async (ctx) => {
		// Déterminer le nom du contact
		var message = ctx.callbackQuery.message.text

		// Le nom se trouve après "du contact" et se trouve entre guillemet
		var name = message.split("du contact")[1].split('"')[1].trim()

		// Supprimer le contact
		await deleteContact(name, ctx)

		// Supprimer le message
		ctx.deleteMessage().catch(err => { })
	})

	// Détecter l'envoi d'un message
	// Note: Ce code doit rester en dessous des autres commandes.
	bot.on('message', async (ctx) => {
		// Empêcher un message envoyé avant le démarrage du bot d'être traité
		if (ctx?.message?.date && ctx.message.date < Math.floor(Date.now() / 1000) - 10) return console.log("Un message envoyé avant le démarrage du bot a été ignoré.")

		// Texte originale
		var text = ctx?.message?.text || ctx?.callbackQuery?.message?.text
		if (text) text = text.trim()
		if (!text) return

		// Auteur du message
		var author = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id

		// Récupérer le message et vérifier que c'est un code
		var parsedText = parseInt(text)
		if (!parsedText || (parsedText && (isNaN(parsedText) || text.length != 6))) { // Si c'est PAS un code
			// On récupère si on doit attendre une réponse de l'utilisateur
			var waitingForReply = waitingForReplies.find(e => e.userId == author)
			if (!waitingForReply) return // Si on attend pas de réponse, on ne fait rien
			if (waitingForReply.created < Date.now() - (1000 * 60 * 10)) waitingForReplies = waitingForReplies.filter(e => e.userId != author) // On laisse max 10 minutes pour répondre

			// On récupère le type de réponse qu'on attend
			var type = waitingForReply.type
			if (type == "createcontact-via-cmd") { // Si on attend une réponse pour créer un contact via la commande
				// On récupère le nom et le numéro
				var name = text.split(",")[0];
				var num = text.split(",")[1];

				// Si il n y a pas de virgule expliquez comment il faut faire.
				if (!name) return ctx.replyWithHTML("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : <b>Jean</b>, 0123456789").catch(err => { })
				if (!num) return ctx.replyWithHTML("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : Jean, <b>0123456789</b>").catch(err => { })

				// Enlever les espaces du numéro
				num = num.trim()

				// Si numero ne contient pas que des chiffres
				if (num.match(/[^0-9]/g)) return ctx.reply("Le numéro ne peut contenir que des chiffres.").catch(err => { })

				// On créé le contact
				var created = await createContact(name, num, ctx);

				// Si il y a une erreur, informer l'utilisateur
				if (created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`).catch(err => { })
				else ctx.reply("Le contact a bien été créé.").catch(err => { })

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if (type == "createcontact-via-btn") { // Si on attend une réponse pour créer un contact via le bouton
				// On créé le contact
				var created = await createContact(text, waitingForReply.num, ctx);

				// Si il y a une erreur, informer l'utilisateur
				if (created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`).catch(err => { })
				else ctx.reply("Le contact a bien été créé.").catch(err => { })

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if (type == "contact") { // Si on attend une réponse pour chercher un contact
				// On récupère le nom
				var name = text;

				// On récupère le contact
				await getContact(name, ctx)

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if (type == "deletecontact") { // Si on attend une réponse pour supprimer un contact
				// On récupère le nom
				var name = text;

				// On supprime le contact
				await deleteContact(name, ctx)

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}

		} else { // Si c'est un code valide :
			// Obtenir le code unique dans la base de données
			var { data, error } = await supabase.from("uniquecode").select("*").eq("code", text)
			if (error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu récupérer les informations de ce code dans la base des données. Veuillez signaler ce problème.").catch(err => { })

			// Si on a pas de données
			if (!data?.length) return ctx.reply("Oups, on dirait bien que ce code n'existe pas. Celui-ci a peut-être expiré, ou est mal écrit. Dans le cas où vous hébergez vous-même le service, vérifier que vous avez entré la bonne URL d'API lors de l'utilisation du CLI.").catch(err => { })

			// Si on a un code, on l'associe à l'utilisateur
			var { error } = await supabase.from("uniquecode").delete().match({ code: text })
			if (error) ctx.reply("Nous n'avons pas pu supprimer ce code d'association, il expirera tout de même dans moins d'une heure. Veuillez signaler ce problème.").catch(err => { })

			// Si on a des données, on vérifie qu'elles ne sont pas expirées
			var infos = data?.[0]
			if (infos?.created) {
				var created = new Date(data.created)
				if (created < new Date(Date.now() - (1000 * 60 * 50))) return ctx.reply("Oups, on dirait bien que ce code a expiré. Veuillez en générer un nouveau.").catch(err => { }) // 50 minutes
			}

			// On vérifie que l'utilisateur n'a pas déjà associé une box
			var { data, error } = await supabase.from("users").select("*").eq("userId", ctx.message.from.id)
			if (error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu vérifier si vous avez déjà associé une Freebox à votre compte. Veuillez signaler ce problème.").catch(err => { })
			if (data?.length) return ctx.reply("Vous avez déjà associé une Freebox à votre compte, utiliser /logout pour la supprimer.").catch(err => { })

			// On associe le code à l'utilisateur
			var { error } = await supabase.from("users").insert({
				id: Date.now() + Math.floor(Math.random() * 1000000).toString(),
				userId: ctx.message.from.id,
				chatId: ctx.message.chat.id,
				appId: "fbx.notifier",
				appToken: infos?.content?.appToken,
				apiDomain: infos?.content?.apiDomain,
				httpsPort: infos?.content?.httpsPort,
				boxModel: infos?.content?.boxModel,
				created: new Date()
			})
			if (error) console.log(error)
			if (error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu vous associer à votre Freebox. Veuillez signaler ce problème.").catch(err => { })

			// On informe l'utilisateur que tout s'est bien passé
			getSupabaseUsers() // On met à jour les utilisateurs
			ctx.reply(`Votre compte Telegram a bien été associé à votre ${getFreeboxName(infos?.content?.boxModel)} !\n\nVous devrez peut-être attendre jusqu'à 5 minutes avant de pouvoir utiliser les commandes du bot, le temps que la synchronisation s'effectue.`).catch(err => { })
		}
	})
}
main().catch((err) => console.error(err));

// Détecter en temps réel les messages vocaux
async function logVoices() {
	// Première itération
	var firstIteration = true

	// Boucle infinie qui vérifie si un nouveau message vocal est reçu
	while (true) {
		// Pour chaque box
		for (const freebox of freeboxs) {
			// Obtenir les derniers appels
			var response = await freebox?.client?.fetch({
				method: "GET",
				url: "v10/call/voicemail/",
				parseJson: true
			})
			if (response?.result?.length) response = response.result.sort((a, b) => b.date - a.date)

			// Enregistrer dans des variables si c'est la première itération
			if(firstIteration || !freebox?.voicemail){
				freebox.voicemail = {}
				freebox.voicemail.length = response?.length || 0
				freebox.voicemail.msgId = response?.[0]?.id || null
				freebox.voicemail.gotOne = false
				freebox.voicemail.duration = null // nécessaire car l'API envoie les vocaux avant qu'ils soient finalisés
				freebox.voicemail.duration2 = null // on doit vérifier deux fois que la durée a changé pour être sûr que le vocal est finalisé
				continue
			}

			// Récupérer la taille du tableau
			var newLength = response?.length || 0

			// Si on a pas de vocs, on continue
			if (!newLength) {
				if (newLength != freebox.voicemail.length) freebox.voicemail.length = newLength // On met à jour la taille
				continue
			}

			// Si on a un NOUVEAU message vocal
			if (newLength > freebox.voicemail.length && freebox.voicemail.msgId != response?.[0]?.id) {
				// On obtient l'ID du dernier message vocal
				console.log('nv voc')
				freebox.voicemail.msgId = response?.[0]?.id || null
				freebox.voicemail.duration = response?.[0]?.duration || null
				freebox.voicemail.gotone = true
				freebox.voicemail.length = newLength // On met à jour la taille
				continue
			}

			// Si on a des vocaux en moins
			else if (newLength < freebox.voicemail.length) {
				console.log('moins de vocs')
				freebox.voicemail.length = newLength // On met à jour la taille
				continue // On continue
			}

			// Si on a autant de vocaux
			else if (newLength == freebox.voicemail.length && freebox.voicemail.gotone) {
				console.log('autant de vocs')
				// On obtient la nouvelle durée
				var newDuration = response?.[0]?.duration || null
				console.log(newDuration, freebox.voicemail.duration2, freebox.lastVoicemailId, freebox.voicemail.msgId)

				// Si la durée a changé deux fois, on déduit que le vocal est finalisé
				if (newDuration == freebox.voicemail.duration2 && freebox.lastVoicemailId != freebox.voicemail.msgId) {
					// On envoie le message vocal
					freebox.voicemail.gotone = false
					freebox.voicemail.duration = newDuration
					freebox.lastVoicemailId = freebox.voicemail.msgId
					await sendVoicemail(freebox.userId || freebox.chatId, freebox.voicemail.msgId, response?.[0]?.phone_number || null)

					// On enregistre que le message vocal a été envoyé
					var { error } = await supabase.from("users").update({ lastVoicemailId: freebox.voicemail.msgId }).match({ userId: freebox.userId || freebox.chatId })
					if (error) console.log(error)

					continue
				}

				// Si la durée a changé qu'une fois, on met à jour la durée
				else if (newDuration == freebox.voicemail.duration && freebox.lastVoicemailId != freebox.voicemail.msgId) freebox.voicemail.duration2 = newDuration
				else freebox.voicemail.duration = newDuration
			}
		}

		// On met à jour la variable
		firstIteration = false

		// On attend 10 secondes avant de retenter d'obtenir les vocs
		// Nécessaire, - de 10 secondes fait que ça fonctionne pas et sah j'ai la flm d'expliquer pourquoi
		await new Promise(r => setTimeout(r, 10000));
	}
}

// Détecter en temps réel les appels entrants
async function logCalls() {
	// Première itération
	var firstIteration = true

	// Boucle infinie qui vérifie si un nouvel appel est reçu
	while (true) {
		// Pour chaque box
		for (const freebox of freeboxs) {
			// On définit des variables de base
			if (!freebox.injoinable) freebox.injoinable = false
			if (!freebox.lastID) freebox.lastID = null

			// Obtenir les derniers appels
			var response = await freebox?.client?.fetch({
				method: "GET",
				url: "v10/call/log/",
				parseJson: true
			})

			// Si la box est vrm injoinable
			if (typeof response?.msg == "object" && JSON.stringify(response) == `{"success":false,"msg":{},"json":{}}`){
				if(!freebox.injoinable) bot.telegram.sendMessage(freebox.chatId || freebox.userId, "Votre Freebox est injoignable. L'accès à Internet est peut-être coupé.").catch(err => {
					console.log(`Impossible de contacter l'utilisateur ${freebox.chatId || freebox.userId} : `, err)
					return disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
				})
				freebox.injoinable = true
				continue
			} else {
				// Si on était injoinable
				if (freebox.injoinable) bot.telegram.sendMessage(freebox.chatId || freebox.userId, "Votre Freebox semble de nouveau connecté à Internet !").catch(err => { })
				freebox.injoinable = false // on est joinable
			}

			// Si on a pas pu s'autentifier
			if (response?.msg == "Erreur d'authentification de l'application") {
				bot.telegram.sendMessage(freebox.chatId || freebox.userId, "Une erreur d'authentification est survenue. Veuillez vous reconnecter via le terminal.")
				return disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
			}

			// Si il y a une erreur, informer l'utilisateur
			if (!response?.success) {
				bot.telegram.sendMessage(freebox.chatId || freebox.userId, `Une erreur est survenue${response?.msg || response?.message || typeof response == 'object' ? ` : ${response.msg || response.message || JSON.stringify(response)}` : "... Signaler ce problème."}`).catch(err => {
					console.log(`Impossible de contacter l'utilisateur ${freebox.chatId || freebox.userId} : `, err)
					return disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
				})
				continue
			}

			// On récupère le dernier appel
			response = response?.result?.[0] || null

			// On ignore les appels qui ne sont pas entrants
			if (response.type == "outgoing") continue

			// Si le dernier appel est différent du dernier appel enregistré
			if (freebox?.lastID != response.id) {
				// On enregistre l'id de l'appel
				var ifLastIdAlreadyExists = freebox.lastID ? true : false
				freebox.lastID = response.id;

				// On ignore le reste si on était à la première itération (permet juste de récupérer le dernier appel)
				if (firstIteration || !ifLastIdAlreadyExists) continue

				// On obtient les infos, et on définit l'ID du dernier appel enregistré
				var number = response.number;
				var name = response.name;

				// On met en forme le numéro
				if (name == number && number.length == 10) {
					name = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")
					number = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")
				}
				if (name != number && number.length == 10) {
					number = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")
				}

				// On enregistre l'id de l'appel
				freebox.lastID = response.id;

				// On prépare le bouton pour créer un contact
				var replyMarkup = null;
				if (number == name && number) {
					replyMarkup = {
						inline_keyboard: [
							[{
								text: "Créer un contact",
								callback_data: "createcontact"
							}]
						]
					};
				}

				// On envoie le message
				await bot.telegram.sendMessage(freebox.chatId || freebox.userId, `Nouvel appel entrant de ${name || "Numéro masqué"}${number != name ? ` \n${number || "Numéro masqué"}` : ''}`, {
					reply_markup: replyMarkup
				}).catch(err => {
					console.log(`Impossible de contacter l'utilisateur ${freebox.chatId || freebox.userId} : `, err)
					return disconnectBox(freebox.chatId || freebox.userId, freebox.id) // On déco la box
				})
			}
		}

		// On met à jour la variable
		firstIteration = false

		// On attend vite fait
		await new Promise(r => setTimeout(r, 500)) // 500ms
	}
}

// Créer un contact
async function createContact(name, num, ctx) {
	// Obtenir les infos sur l'utilisateur
	const userId = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id
	const freebox = freeboxs.find(e => e.userId == userId)

	// Créer un contact
	var response = await freebox?.client?.fetch({
		method: "POST",
		url: "v10/contact/",
		body: JSON.stringify({
			display_name: name, // Avec son nom uniquement, pour l'instant
		}),
		parseJson: true
	});

	// Récupérer l'ID du contact
	const id = response.result.id;

	// Ajouter le numéro au contact
	const addNumber = await freebox?.client?.fetch({
		method: "POST",
		url: "v10/number/",
		body: JSON.stringify({
			contact_id: id,
			number: num, // Lui définir le numéro
		}),
		parseJson: true
	});

	return addNumber?.success || addNumber?.msg || false
}

// Obtenir le numéro de téléphone
async function myNumber(ctx) {
	// Obtenir les infos sur l'utilisateur
	const userId = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id
	const freebox = freeboxs.find(e => e.userId == userId)

	// Requête pour récupérer quelques informations sur le compte
	var response = await freebox?.client?.fetch({
		method: "GET",
		url: "v10/call/account/",
		parseJson: true
	})
	return response?.result?.phone_number;
}

// Obtenir un contact
async function getContact(name, ctx) {
	// Obtenir les infos sur l'utilisateur
	const userId = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id
	const freebox = freeboxs.find(e => e.userId == userId)

	// On récupère les contacts
	var response = await freebox?.client?.fetch({
		method: "GET",
		url: "v10/contact/",
		parseJson: true
	});

	// Si on a une erreur
	if (!response?.success) return ctx.reply("Impossible de récupérer les contacts : " + response.msg || response).catch(err => { })

	// Si l'entrée de l'utilisateur correspond au firstname ou lastname d'un contact
	var contacts = response?.result || []
	name = name.toLowerCase().trim() // permet de rechercher sans tenir compte de la casse
	var contact = contacts.find(e => e.display_name.toLowerCase().trim() == name || e.first_name.toLowerCase().trim() == name || e.last_name.toLowerCase().trim() == name)

	// Si on a pas de contact
	if (!contact) return ctx.reply("Aucun contact n'a pu être trouvé.").catch(err => { })

	// On récupère les numéros du contact
	var response = await freebox?.client?.fetch({
		method: "GET",
		url: `v10/contact/${contact.id}/numbers/`,
		parseJson: true
	});

	// Si on a une erreur
	if (!response?.success) return ctx.reply("Impossible de récupérer le numéro du contact : " + response.msg || response).catch(err => { })

	// Si on a pas de numéros
	var numbers = response?.result || []
	if (!numbers.length) return ctx.reply("Le contact existe mais aucun numéro n'a pu être trouvé.").catch(err => { })

	// On envoie le ou les numéros
	var message = `Numéro${numbers.length > 1 ? "s" : ""} du contact "${contact.display_name || contact.first_name + contact.last_name}" :\n`
	numbers.forEach(e => {
		message += `${e.number}\n`
	})

	// Ajouter un bouton pour supprimer le contact
	var replyMarkup = {
		inline_keyboard: [
			[{
				text: "Supprimer le contact",
				callback_data: `deletecontact`
			}]
		]
	}
	// Envoyer le message avec le bouton
	ctx.reply(message, { reply_markup: replyMarkup }).catch(err => { })
}

// Supprimer un contact
async function deleteContact(name, ctx) {
	// Obtenir les infos sur l'utilisateur
	const userId = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id
	const freebox = freeboxs.find(e => e.userId == userId)

	// On récupère les contacts
	var response = await freebox?.client?.fetch({
		method: "GET",
		url: "v10/contact/",
		parseJson: true
	});

	// Si on a une erreur
	if (!response?.success) return ctx.reply("Impossible de récupérer les contacts : ", response.msg || response).catch(err => { })

	// Si l'entrée de l'utilisateur correspond au firstname ou lastname d'un contact
	var contacts = response?.result || []
	name = name.toLowerCase().trim() // permet de rechercher sans tenir compte de la casse
	var contact = contacts.find(e => e.display_name.toLowerCase().trim() == name || e.first_name.toLowerCase().trim() == name || e.last_name.toLowerCase().trim() == name)

	// Si on a pas de contact
	if (!contact) return ctx.reply("Aucun contact n'a pu être trouvé.").catch(err => { })

	// On supprime le contact
	var response = await freebox?.client?.fetch({
		method: "DELETE",
		url: `v10/contact/${contact.id}/`,
		parseJson: true
	});

	// Si on a une erreur
	if (!response?.success) return ctx.reply("Impossible de supprimer le contact : ", response.msg || response).catch(err => { })

	// On informe l'utilisateur que le contact a bien été supprimé
	ctx.reply("Le contact a bien été supprimé.").catch(err => { })
}

// Envoyer le dernier message vocal dans le répondeur
async function sendVoicemail(userId, voiceId, number) {
	// Obtenir les infos sur l'utilisateur
	const freebox = freeboxs.find(e => e.userId == userId)

	// Obtenir les messages vocaux
	if (!voiceId) {
		var response = await freebox?.client?.fetch({
			method: "GET",
			url: "v10/call/voicemail/",
			parseJson: true
		});

		// Si on a une erreur
		if (!response?.success) return bot.telegram.sendMessage(userId, "Impossible de récupérer les derniers appels : ", response?.msg || response).catch(err => { })

		// On trie pour avoir le plus récent
		response = response?.result || []
		response = response.sort((a, b) => b.date - a.date)

		// Si on a rien
		if (!response.length) return bot.telegram.sendMessage(userId, "Vous n'avez aucun message vocal.").catch(err => { })

		// On récupère le dernier
		voiceId = response?.[0]?.id || null
		number = response?.[0]?.phone_number || null
	}

	// On récupère les contacts
	var response = await freebox?.client?.fetch({
		method: "GET",
		url: "v10/contact/",
		parseJson: true
	});

	// On rend le numéro de téléphone plus lisible
	if (!number) number = "Numéro masqué"
	if (number.length && !number.startsWith("0") && !number.startsWith("N")) number = "0" + number
	if (number.length == 10) number = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")

	// On télécharge le message vocal
	var responseAudio = await freebox?.client?.fetch({
		method: "GET",
		url: `v10/call/voicemail/${voiceId}/audio_file/`
	})

	// (au cas où y'a une erreur de l'API et donc on peut pas obtenir le buffer)
	try {
		// On récupère le buffer
		responseAudio = await responseAudio.buffer()

		// On prépare les infos pour enregistrer le fichier
		var randomid = Math.floor(Math.random() * 1000000).toString()
		var file = `${randomid}_audio.wav`

		// On écrit les données dans le fichier
		fs.writeFileSync(file, responseAudio)

		// Convertir un fichier .wav en .mp3
		var audio = await new ffmpeg(file);

		// Afficher une information à l'utilisateur
		audio.fnExtractSoundToMP3(`${randomid}_audio.mp3`, async function (error) {
			// Créé un bouton pour supprimer le message vocal
			var replyMarkup = {
				inline_keyboard: [
					[{
						text: "Supprimer le dernier message du répondeur",
						callback_data: `delete-voicemail`
					}],
					[{
						text: "Transcrire",
						callback_data: `transcribe-voicemail`
					}]
				]
			}

			// Si on a pas d'erreur, envoie le mp3
			if (!error) {
				// Envoyer le message vocal grâce à bot.telegram
				await bot.telegram.sendAudio(userId, { source: `${randomid}_audio.mp3` }, {
					reply_markup: replyMarkup, // Ajouter le bouton au message
					title: "Message vocal",
					performer: number
				}).catch(err => { })

				// Supprimer les fichier généré
				try {
					setTimeout(() => {
						fs.unlinkSync(file)
						fs.unlinkSync(`${randomid}_audio.mp3`)
					}, 2000) // au cas où
				} catch (err) { }
			} else {
				// On envoie le fichier wav d'origine
				await bot.telegram.sendAudio(userId, { source: file }, {
					reply_markup: replyMarkup, // Ajouter le bouton au message
					title: "Message vocal",
					performer: number
				}).catch(err => { })

				// Supprimer les fichier généré
				try {
					setTimeout(() => {
						fs.unlinkSync(file)
						fs.unlinkSync(`${randomid}_audio.mp3`)
					}, 2000) // au cas où
				} catch (err) { }
			}
		});
	} catch (err) {
		console.log(err)
		bot.telegram.sendMessage(userId, "Impossible de récupérer le message vocal : " + err.msg || err.message || err.code || err).catch(err => { })
	}
}