const { FreeboxClient } = require("freebox-wrapper");
const fs = require('fs');
require('dotenv').config();
const { Telegraf } = require('telegraf')
var bot = new Telegraf(process.env.BOT_TOKEN)
var id = process.env.TELEGRAM_ID


// On initialise le client
const freebox = new FreeboxClient({
	appId: 'fbx.telegram_notifier',
	appToken: process.env.FREEBOX_TOKEN,
	apiDomain: process.env.FREEBOX_DOMAIN,
	httpsPort: process.env.FREEBOX_PORT
});

async function main() {
	// On s'authentifie
	var response = await freebox.authentificate()

	// Si on a pas pu s'authentifier
	if (!response?.success) return console.log("Impossible de se connecter à la Freebox : ", response.msg || response)

	// Lancer le bot et print
	bot.launch()
	console.log(`Le bot a bien démarré.`)

	// Commencer la fonction logCalls
	logCalls()

	// Commande start du bot pour une première connexion en lui expliquant au fur et à mesure
	bot.command('start', (ctx) => {
		// TODO: INCLURE LE LIEN
		ctx.reply("Bienvenue !\nSi vous ne vous êtes pas authentifier sur le CLI alors suivez ce lien afin de le télécharger.\nSinon faites la commande /login pour obtenir votre code d'authentification.").catch(err => { })
	})

	// Commande login
	bot.command('login', (ctx) => {
		// Génerer un token à 6 chiffres.
		var token = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
		// Envoyer le token à l'utilisateur
		ctx.reply("Veuillez entrer le token suivant dans le CLI : " + token).catch(err => { })
	})

	// Commande logout
	bot.command('logout', async (ctx) => {
		// Demander à l'utilisateur si il est sur de vouloir se déconnecter
		var replyMarkup = null;
		replyMarkup = {
			inline_keyboard: [
				[
					{
						text: "Oui",
						callback_data: "yes"
					},
					{
						text: "Non",
						callback_data: "no"
					},
				]
			]
		};
		// Afficher un message d'attention avec les boutons.
		ctx.replyWithHTML("⚠️ <b>ATTENTION</b> Si vous vous déconnecter vous ne recevrez plus vos appels ici.\nSi vous souhaitez vous reconnecter plus tard vous devrez recommencer le processus d'installation.\n<b> Êtes-vous sûr de vouloir vous déconnecter ? </b>", {
			reply_markup: replyMarkup
		});
		// Bouton non cliqué
		bot.action('no', async (ctx) => {
			// Répondre au callback
			ctx.answerCbQuery("Annulé.")
			// Supprimer le message de l'utilisateur
			ctx.deleteMessage().catch(err => { })
		})

		// Bouton oui cliqué
		bot.action('yes', async (ctx) => {
			// Répondre au callback
			ctx.answerCbQuery("Déconnexion...")
			// Supprimer le token de l'utilisateur dans supabase
			// await supabase.from('tokens').delete().match({ id: ctx.message.from.id })
		})
	})

	// Commande voicemail
	bot.command('voicemail', async (ctx) => {
		ctx.reply("Voici le dernier message vocal :")
		await sendVoicemail(ctx);
	})

	// Commande createcontact
	bot.command('createcontact', (ctx) => {
		// Demander à l'utilisateur de rentrer le nom et le numéro du contact
		ctx.reply("Veuillez entrer le nom du contact ainsi que son numéro a créer séparer d'une virgule :\nExemple : Jean, 0123456789")

		// Attendre la réponse de l'utilisateur
		bot.on('text', async (ctx) => {
			var text = ctx.message.text;
			var name = text.split(",")[0];
			var num = text.split(",")[1];

			// Si il n y a pas de virgule expliquez comment il faut faire.
			if (num == undefined) return ctx.reply("Veuillez entrer le nom du contact ainsi que son numéro a créer séparer d'une virgule. :\nExemple : `Jean, 0123456789`")

			// On créé le contact
			var created = await createContact(name, num);

			// Si il y a une erreur, informer l'utilisateur
			if (created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`)
		})
	})

	// Commande mynumber
	bot.command('mynumber', async (ctx) => {
		ctx.reply("Votre numéro de téléphone fixe est le : " + await myNumber()) // Récupérer le numéro de téléphone fixe
	})

	// Commande report
	bot.command('report', (ctx) => {
		// Demander à l'utilisateur quel est le problème
		var replyMarkup = null;
		replyMarkup = {
			inline_keyboard: [
				[
					{
						text: "Annuler",
						callback_data: "cancel"
					},
				]
			]
		};
		ctx.reply("Veuillez entrer le problème rencontré en détaillant.\n- Vous devez y inclure comment reproduire le problème.\n- Si vous avez une erreur, veuillez la copier-coller.", {
			reply_markup: replyMarkup
		});

		// Si le bouton annuler est cliqué
		bot.action('cancel', async (ctx) => {
			// Informer que rien ne sera envoyé
			ctx.answerCbQuery("Annulé.")
			// Supprimer le message de l'utilisateur
			ctx.deleteMessage().catch(err => { })
		})

		// Attendre la réponse de l'utilisateur
		bot.on('text', async (ctx) => {
			var text = ctx.message.text;
			// Récupérer le @ de l'utilisateur
			var user = ctx.message.from.username;
			// Envoyer le message à el2zay
			bot.telegram.sendMessage(id, `Problème rencontré : ${text}.\nPar t.me/${user}`)
			ctx.reply("Merci. Votre problème a bien été signalé.")
		})
	})

	// Action du bouton "Créer un contact"
	bot.action('createcontact', async (ctx) => {
		var message = ctx.callbackQuery.message.text; // Récupérer le message depuis le callback
		var num = message.split("de")[1].split("(")[0].trim(); // Récupérer le numéro de téléphone depuis le message

		// Si le numéro est masqué, ne rien faire
		if (num == "Numéro masqué") {
			// Répondre au callback
			return ctx.answerCbQuery("Impossible de créé le contact car le numéro est masqué.");
		}

		// Demander le nom du contact a mettre
		ctx.reply("Veuillez entrer le nom du contact a créé")

		// Attendre la réponse de l'utilisateur
		bot.on('text', async (ctx) => {
			var name = ctx.message.text

			// On créé le contact
			var created = await createContact(name, num);

			// Si il y a une erreur, informer l'utilisateur
			if (created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`)
		})
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
	if (!response.success) return console.log("Impossible de récupérer les derniers appels : ", response.msg || response)

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
		if (!response.success) return console.log("Impossible de récupérer les derniers appels : ", response.msg || response)

		// Si le dernier appel est différent du dernier appel enregistré
		response = response?.result?.[0] || null
		if (lastID != response.id) {
			// On obtient les infos, et on définit l'ID du dernier appel enregistré
			number = response.number;
			var name = response.name;
			lastID = response.id;

			// On ignore les appels qui ne sont pas entrants
			if (response.type == "outgoing") continue

			// Si l'appel est entrant
			var replyMarkup = null;
			if (number == name) {
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

async function createContact(name, num) {
	// Créer un contact
	const response = await freebox.fetch({
		method: "POST",
		url: "v10/contact/",
		body: JSON.stringify({
			display_name: name, // Avec son nom uniquement
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


async function myNumber() {
	// Requête pour récupérer quelques informations sur le compte
	const response = await freebox.fetch({
		method: "GET",
		url: "v10/call/account/",
		parseJson: true
	});

	return response.result.phone_number;
}

async function sendVoicemail(ctx) {
	// Obtenir les messages vocaux
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/call/voicemail/",
		parseJson: true
	});

	// Si on a une erreur
	if (!response.success) return ctx.reply("Impossible de récupérer les derniers appels : ", response.msg || response)

	// On trie pour avoir le plus récent
	response = response?.result || []
	response = response.sort((a, b) => b.date - a.date)

	// Si on a rien
	if (!response.length) return ctx.reply("Vous n'avez aucun message vocal.")

	// On télécharge le message vocal
	var responseAudio = await freebox.fetch({
		method: "GET",
		url: `v10/call/voicemail/${response?.[0]?.id}/audio_file/`
	})
	responseAudio = await responseAudio.buffer()

	// On l'enregistre
	var randomid = Math.floor(Math.random() * 1000000).toString()
	fs.writeFile(`${randomid}_audio.wav`, responseAudio, function (err) {
		if (err) throw err
	})

	// On envoie le message vocal
	await ctx.replyWithVoice({ source: `${randomid}_audio.wav` })

	// On supprime le message vocal local
	fs.unlink(`${randomid}_audio.wav`, function (err) {
		if (err) throw err
	})
}