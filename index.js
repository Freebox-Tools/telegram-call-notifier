// Importer les libs
const { FreeboxClient } = require("freebox-wrapper");
const fs = require('fs');
require('dotenv').config();
const { Telegraf } = require('telegraf')
var bot = new Telegraf(process.env.BOT_TOKEN)
var id = process.env.TELEGRAM_ID

// Supabase
var { createClient } = require("@supabase/supabase-js")
var supabase = createClient(process.env.SUPABASE_LINK, process.env.SUPABASE_PUBLIC_KEY)
// TODO: on précisera dans Le README qu'il faut pas leak la SUPABASE_PUBLIC_KEY mm si le nom indique qu'elle est publique, c'est pas vrm le cas
// TODO: on précisera aussi dans le README d'activer les RLS (voir celle déjà définit dans la base de données)

// Liste des réponses d'utilisateur qu'on attend
var waitingForReplies = []

// On initialise le client
const freebox = new FreeboxClient({
	appId: 'fbx.notifier',
	appToken: process.env.FREEBOX_TOKEN,
	apiDomain: process.env.FREEBOX_DOMAIN,
	httpsPort: process.env.FREEBOX_PORT
})

// Liste des noms des Freebox
function getFreeboxName(name){
	if(name.includes("Freebox Server Mini")) return "Freebox Mini 4K"
	if(name.includes("Freebox Delta")) return "Freebox Delta"
	if(name.includes("Freebox Pop")) return "Freebox Pop"
	if(name.includes("Freebox Révolution") || name.includes("Freebox Revolution")) return "Freebox Révolution"
	if(name.includes("Freebox One")) return "Freebox One"
	if(name.includes("Freebox Server")) return "Freebox Server"
	return "Freebox"
}

// Fonction principale
async function main() {
	// On s'authentifie
	var response = await freebox.authentificate()

	// Si on a pas pu s'authentifier
	if(!response?.success) return console.log("Impossible de se connecter à la Freebox : ", response.msg || response)
	else console.log("Connecté à Freebox OS sur " + getFreeboxName(freebox.freebox.box_model_name))

	// Lancer le bot
	bot.launch()

	// Commencer la fonction logCalls
	logCalls()

	// Commande start du bot pour une première connexion en lui expliquant au fur et à mesure
	bot.command('start', (ctx) => {
		ctx.replyWithHTML(`
Bienvenue dans Freebox Call Notifier ! Ce bot vous permet de recevoir une notification lors d'un appel entrant sur votre Freebox.

Pour associer une Freebox à votre compte Telegram, vous devrez utiliser l'assistant de configuration via terminal sur un ordinateur connecté au même réseau que votre Freebox.

1. Assurez-vous d'avoir <a href="https://nodejs.dev/fr/download/">Node.js</a> installé sur votre ordinateur.
2. Ouvrez un terminal ("Invite de commandes" sur Windows).
3. Dans ce terminal, entrez la commande suivante : <code>npx freebox-notifier-cli</code>
4. Suivez les instructions affichées dans le terminal.

En cas de problème, vous pouvez contacter <a href="https://t.me/el2zay">el2zay</a>.`
		, { disable_web_page_preview: true, allow_sending_without_reply: true }).catch(err => {})
	})

	// Commande logout
	bot.command('logout', async (ctx) => {
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
		}).catch(err => {})

		// Si on annule
		bot.action(`no-${id}`, async (ctx) => {
			// Répondre et supprimer le message
			ctx.answerCbQuery("Action annulé ! Vous ne serez pas déconnecté.").catch(err => {})
			ctx.deleteMessage().catch(err => {})
		})

		// Si on confirme
		bot.action(`yes-${id}`, async (ctx) => {
			// Supprimer les informations de la base de données
			var { error } = await supabase.from("users").delete().match({ userId: ctx?.update?.callback_query?.from?.id })
			if(error) return ctx.answerCbQuery("Une erreur est survenue lors de la déconnexion : " + error.message).catch(err => {})

			// Répondre et supprimer le message
			ctx.deleteMessage().catch(err => {})
			ctx.reply("Vous avez été déconnecté. Une attente de quelques minutes est nécessaire avant la suppression totale de vos données.").catch(err => {})

			// On se décconecte de la Freebox (on vérifie pas l'erreur)
			await freebox.fetch({
				method: "POST",
				url: "v10/login/logout/",
				parseJson: true
			})
		})
	})

	// Commande voicemail
	bot.command('voicemail', async (ctx) => {
		await sendVoicemail(ctx);
	})

	// Commande createcontact
	bot.command('createcontact', (ctx) => {
		// Demander à l'utilisateur d'envoyer un message
		ctx.reply("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : Jean, 0123456789").catch(err => {})

		// On attend la réponse de l'utilisateur
		if(waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "createcontact-via-cmd",
			ctx: ctx
		})
	})

	// Commande mynumber
	bot.command('mynumber', async (ctx) => {
		ctx.reply("Votre numéro de téléphone fixe est le : " + await myNumber()).catch(err => {})
	})

	// Action du bouton "Créer un contact"
	bot.action('createcontact', async (ctx) => {
		// Déterminer le numéro de téléphone
		var message = ctx.callbackQuery.message.text
		var num = message.split("de")[1].split("(")[0].trim()

		// Si le numéro est masqué, ne rien faire
		if(num == "Numéro masqué") return ctx.answerCbQuery("Impossible de créer le contact puisque le numéro est masqué.").catch(err => {})

		// Demander le nom du contact
		ctx.reply(`Veuillez envoyer le nom du contact à ajouter au numéro "${num}"`).catch(err => {})

		// On attend la réponse de l'utilisateur
		if(waitingForReplies.find(e => e.userId == ctx.callbackQuery.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.callbackQuery.from.id)
		waitingForReplies.push({
			userId: ctx.callbackQuery.from.id,
			created: Date.now(),
			type: "createcontact-via-btn",
			ctx: ctx,
			num: num
		})
	})
	
	// Détecter l'envoi d'un message
	// Note: Ce code doit rester en dessous des autres commandes, jsp pourquoi c'est comme ça 💀💀
	bot.on('message', async (ctx) => {
		// Empêcher un message envoyé avant le démarrage du bot d'être traité
		if(ctx?.message?.date && ctx.message.date < Math.floor(Date.now() / 1000) - 10) return console.log("Un message envoyé avant le démarrage du bot a été ignoré.")

		// Texte originale
		var text = ctx?.message?.text || ctx?.callbackQuery?.message?.text
		if(text) text = text.trim()
		if(!text) return

		// Auteur du message
		var author = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id

		// Récupérer le message et vérifier que c'est un code
		var parsedText = parseInt(text)
		if(!parsedText || (parsedText && (isNaN(parsedText) || text.length != 6))){ // Si c'est PAS un code
			// On récupère si on doit attendre une réponse de l'utilisateur
			var waitingForReply = waitingForReplies.find(e => e.userId == author)
			if(!waitingForReply) return // Si on attend pas de réponse, on ne fait rien
			if(waitingForReply.created < Date.now() - (1000 * 60 * 10)) waitingForReplies = waitingForReplies.filter(e => e.userId != author) // On laisse max 10 minutes pour répondre

			// On récupère le type de réponse qu'on attend
			var type = waitingForReply.type
			if(type == "createcontact-via-cmd"){ // Si on attend une réponse pour créer un contact via la commande
				// On récupère le nom et le numéro
				var name = text.split(",")[0];
				var num = text.split(",")[1];

				// Si il n y a pas de virgule expliquez comment il faut faire.
				if(!name) return ctx.replyWithHTML("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : <b>Jean</b>, 0123456789").catch(err => {})
				if(!num) return ctx.replyWithHTML("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : Jean, <b>0123456789</b>").catch(err => {})

				// On créé le contact
				var created = await createContact(name, num);

				// Si il y a une erreur, informer l'utilisateur
				if(created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`).catch(err => {})
				else ctx.reply("Le contact a bien été créé.").catch(err => {})

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if(type == "createcontact-via-btn"){ // Si on attend une réponse pour créer un contact via le bouton
				// On créé le contact
				var created = await createContact(text, waitingForReply.num);

				// Si il y a une erreur, informer l'utilisateur
				if(created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`).catch(err => {})
				else ctx.reply("Le contact a bien été créé.").catch(err => {})

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
		} else { // Si c'est un code valide :
			// Obtenir le code unique dans la base de données
			var { data, error } = await supabase.from("uniquecode").select("*").eq("code", text)
			if(error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu récupérer les informations de ce code dans la base des données. Veuillez signaler ce problème.").catch(err => {})

			// Si on a pas de données
			if(!data?.length) return ctx.reply("Oups, on dirait bien que ce code n'existe pas. Celui-ci a peut-être expiré, ou est mal écrit. Dans le cas où vous hébergez vous-même le service, vérifier que vous avez entré la bonne URL d'API lors de l'utilisation du CLI.").catch(err => {})

			// Si on a un code, on l'associe à l'utilisateur
			var { error } = await supabase.from("uniquecode").delete().match({ code: text })
			if(error) ctx.reply("Nous n'avons pas pu supprimer ce code d'association, il expirera tout de même dans moins d'une heure. Veuillez signaler ce problème.").catch(err => {})

			// Si on a des données, on vérifie qu'elles ne sont pas expirées
			var infos = data?.[0]
			if(infos?.created){
				var created = new Date(data.created)
				if(created < new Date(Date.now() - (1000 * 60 * 50))) return ctx.reply("Oups, on dirait bien que ce code a expiré. Veuillez en générer un nouveau.").catch(err => {}) // 50 minutes
			}

			// On vérifie que l'utilisateur n'a pas déjà associé une box
			var { data, error } = await supabase.from("users").select("*").eq("userId", ctx.message.from.id)
			if(error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu vérifier si vous avez déjà associé une Freebox à votre compte. Veuillez signaler ce problème.").catch(err => {})
			if(data?.length) return ctx.reply("Vous avez déjà associé une Freebox à votre compte, utiliser /logout pour la supprimer.").catch(err => {})

			// On associe le code à l'utilisateur
			var { error } = await supabase.from("users").insert({
				id: Date.now() + Math.floor(Math.random() * 1000000).toString(),
				userId: ctx.message.from.id,
				chatId: ctx.message.chat.id,
				appId: "fbox.notifier",
				appToken: infos?.content?.appToken,
				apiDomain: infos?.content?.apiDomain,
				httpsPort: infos?.content?.httpsPort,
				boxModel: infos?.content?.boxModel,
				created: new Date()
			})
			if(error) console.log(error)
			if(error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu vous associer à votre Freebox. Veuillez signaler ce problème.").catch(err => {})

			// On informe l'utilisateur que tout s'est bien passé
			ctx.reply(`Votre compte Telegram a bien été associé à votre ${getFreeboxName(infos?.content?.boxModel)}. Vous pouvez désormais utiliser les commandes du bot et vous recevrez un message lors d'un appel entrant.`).catch(err => {})
		}
	})
}
main().catch((err) => console.error(err));

async function logCalls() {
	var number;
	// Obtenir les derniers appels
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/call/log/",
		parseJson: true
	});
	if(!response.success) return console.log("Impossible de récupérer les derniers appels : ", response.msg || response)

	// On récupère le dernier appel
	lastID = response?.result?.[0]?.id || null

	// Boucle infinie qui vérifie si un nouvel appel est reçu
	while (true) {
		// Obtenir les derniers appels
		var response = await freebox.fetch({
			method: "GET",
			url: "v10/call/log/",
			parseJson: true
		})

		// Si il y a une erreur, informer l'utilisateur
		// Peut arriver si l'utilisateur a déconnecté l'app depuis son Freebox OS, ou que sa box down
		if(!response.success) return console.log("Impossible de récupérer les derniers appels : ", response.msg || response)

		// Si le dernier appel est différent du dernier appel enregistré
		response = response?.result?.[0] || null
		if(!response) continue // Si on a pas de réponse, on continue
		if(lastID != response.id) {
			// On obtient les infos, et on définit l'ID du dernier appel enregistré
			number = response.number;
			var name = response.name;
			lastID = response.id;

			// On ignore les appels qui ne sont pas entrants
			if(response.type == "outgoing") continue

			// Si l'appel est entrant
			var replyMarkup = null;
			if(number == name) {
				replyMarkup = {
					inline_keyboard: [
						[{
							text: "Créer un contact",
							callback_data: "createcontact"
						}]
					]
				};
			}
			bot.telegram.sendMessage(id, `Nouvel appel entrant de ${name || "Numéro masqué"}${number != name ? ` (${number || "Numéro masqué"})` : ''}`, {
				reply_markup: replyMarkup
			});
		}
	}
}

// Créer un contact
async function createContact(name, num) {
	// Créer un contact
	const response = await freebox.fetch({
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
	const addNumber = await freebox.fetch({
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
async function myNumber() {
	const response = await freebox.fetch({
		method: "GET",
		url: "v10/call/account/",
		parseJson: true
	})
	return response?.result?.phone_number;
}

// Envoyer le dernier message vocal dans le répondeur
async function sendVoicemail(ctx) {
	// Obtenir les messages vocaux
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/call/voicemail/",
		parseJson: true
	});

	// Si on a une erreur
	if(!response.success) return ctx.reply("Impossible de récupérer les derniers appels : ", response.msg || response).catch(err => {})

	// On trie pour avoir le plus récent
	response = response?.result || []
	response = response.sort((a, b) => b.date - a.date)

	// Si on a rien
	if(!response.length) return ctx.reply("Vous n'avez aucun message vocal.").catch(err => {})

	// On télécharge le message vocal
	var responseAudio = await freebox.fetch({
		method: "GET",
		url: `v10/call/voicemail/${response?.[0]?.id}/audio_file/`
	})

	// (au cas où y'a une erreur de l'API et donc on peut pas obtenir le buffer)
	try {
		// On récupère le buffer
		responseAudio = await responseAudio.buffer()

		// On l'enregistre
		var randomid = Math.floor(Math.random() * 1000000).toString()
		fs.writeFile(`${randomid}_audio.wav`, responseAudio, function (err) {
			if(err) throw err
		})

		// On envoie le message vocal
		await ctx.replyWithVoice({ source: `${randomid}_audio.wav` }).catch(err => {})

		// On supprime le message vocal local
		fs.unlink(`${randomid}_audio.wav`, function (err) {
			if(err) throw err
		})
	} catch (err) {
		ctx.reply("Impossible de récupérer le message vocal : " + err.message).catch(err => {})
	}
}